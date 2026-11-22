import {
  CitationApiSchema,
  ImageSearchApiRequestSchema,
  KnowledgeProblemSchema,
  MultiSpaceSearchApiRequestSchema,
  SearchApiRequestSchema,
  SearchApiResponseSchema,
} from '@kb/contracts';
import type {
  CitationApi,
  KnowledgeProblem,
  MultiSpaceSearchApiRequest,
  SearchApiRequest,
  SearchApiResponse,
} from '@kb/contracts';

type ConsumerRole = 'workflow' | 'agent' | 'chat' | 'import';

interface ConsumerJob {
  role: ConsumerRole;
  baseUrl: string;
  workspaceId: string;
  requestId: string;
  traceId?: string;
  query: string;
  knowledgeSpaceId: string;
  knowledgeSpaceIds?: string[];
  tokenBudget: number;
  filters?: Record<string, unknown>;
  importBody?: Record<string, unknown>;
}

interface EnvelopeSuccess<T> {
  success: true;
  data: T;
  traceId: string;
  requestId: string;
}

interface JobView {
  jobId: string;
  kind?: string;
  status: string;
  result?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
}

const key = process.env.KB_B18_API_KEY?.trim();

function safeProblem(value: unknown): KnowledgeProblem | null {
  const parsed = KnowledgeProblemSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function assertKnowledgePath(baseUrl: string, path: string): URL {
  const url = new URL(path, `${new URL(baseUrl).origin}/`);
  if (!url.pathname.startsWith('/v1/knowledge/')) {
    throw new Error('consumer path outside /v1/knowledge/');
  }
  return url;
}

async function request(
  job: ConsumerJob,
  path: string,
  input: { method?: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string } = {},
): Promise<{ status: number; payload: unknown; response: Response }> {
  if (!key) throw new Error('KB_B18_API_KEY is required');
  const url = assertKnowledgePath(job.baseUrl, path);
  const idempotencyKey =
    input.method === 'POST' ? (input.idempotencyKey ?? job.requestId) : undefined;
  const response = await fetch(url, {
    method: input.method ?? 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${key}`,
      'x-workspace-id': job.workspaceId,
      'x-request-id': idempotencyKey ?? job.requestId,
      traceparent: `00-${(job.traceId ?? job.requestId)
        .replace(/[^a-f0-9]/gi, '')
        .padEnd(32, '0')
        .slice(0, 32)}-${(job.traceId ?? job.requestId)
        .replace(/[^a-f0-9]/gi, '')
        .padEnd(16, '0')
        .slice(0, 16)}-01`,
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload, response };
}

function successEnvelope<T>(
  input: { status: number; payload: unknown; response: Response },
  parse: (value: unknown) => T,
) {
  if (!input.response.ok) {
    const problem = safeProblem(input.payload);
    return {
      ok: false as const,
      status: input.status,
      ...(problem ? { problem } : {}),
      headers: {
        requestId: input.response.headers.get('x-request-id'),
        traceId: input.response.headers.get('x-trace-id'),
      },
    };
  }
  if (
    typeof input.payload !== 'object' ||
    input.payload === null ||
    (input.payload as { success?: unknown }).success !== true
  ) {
    return { ok: false as const, status: input.status, malformedEnvelope: true };
  }
  const envelope = input.payload as EnvelopeSuccess<unknown>;
  return {
    ok: true as const,
    status: input.status,
    data: parse(envelope.data),
    traceId: envelope.traceId,
    requestId: envelope.requestId,
  };
}

function searchRequest(job: ConsumerJob): SearchApiRequest {
  return SearchApiRequestSchema.parse({
    knowledgeSpaceId: job.knowledgeSpaceId,
    query: job.query,
    tokenBudget: job.tokenBudget,
    searchMode: job.role === 'workflow' ? 'hybrid' : job.role === 'agent' ? 'semantic' : 'hybrid',
    usingRerank: false,
    ...(job.filters ? { filters: job.filters } : {}),
  });
}

async function citation(job: ConsumerJob, citationId: string): Promise<CitationApi> {
  const response = await request(job, `/v1/knowledge/citations/${encodeURIComponent(citationId)}`);
  const result = successEnvelope(response, (value) => CitationApiSchema.parse(value));
  if (!result.ok) throw Object.assign(new Error('Citation request failed'), result);
  return result.data;
}

async function workflow(job: ConsumerJob) {
  const input = MultiSpaceSearchApiRequestSchema.parse({
    ...searchRequest(job),
    knowledgeSpaceIds: job.knowledgeSpaceIds ?? [job.knowledgeSpaceId],
  }) satisfies MultiSpaceSearchApiRequest;
  const response = await request(job, '/v1/knowledge/search/multi-space', {
    method: 'POST',
    body: input,
  });
  const result = successEnvelope(response, (value) => SearchApiResponseSchema.parse(value));
  if (!result.ok) return result;
  const data: SearchApiResponse = result.data;
  const citationIds = data.items.map((item) => item.citation.citationId);
  return {
    ...result,
    citationIds,
    stopReason: data.partial
      ? 'partial_dependency'
      : data.items.length === 0
        ? 'empty'
        : 'completed',
    nextStep: { name: 'workflow-complete', acceptedCount: data.items.length, sideEffects: 'none' },
  };
}

async function agent(job: ConsumerJob) {
  const input = searchRequest(job);
  const path = job.query.startsWith('image:')
    ? '/v1/knowledge/search/image'
    : '/v1/knowledge/search/semantic';
  const parsed = path.endsWith('/image')
    ? ImageSearchApiRequestSchema.parse({ ...input, query: job.query.slice('image:'.length) })
    : input;
  const response = await request(job, path, { method: 'POST', body: parsed });
  const result = successEnvelope(response, (value) => SearchApiResponseSchema.parse(value));
  if (!result.ok) return result;
  const data = result.data;
  const firstCitation = data.items[0]?.citation.citationId;
  const citationRecord = firstCitation ? await citation(job, firstCitation) : null;
  return {
    ...result,
    citationIds: data.items.map((item) => item.citation.citationId),
    citationRecord,
    stopReason: data.items.length === 0 ? 'empty' : 'completed',
  };
}

async function chat(job: ConsumerJob) {
  const input = SearchApiRequestSchema.parse({ ...searchRequest(job), searchMode: 'hybrid' });
  const response = await request(job, '/v1/knowledge/search/hybrid', {
    method: 'POST',
    body: input,
  });
  const result = successEnvelope(response, (value) => SearchApiResponseSchema.parse(value));
  if (!result.ok) return result;
  const data = result.data;
  const records: CitationApi[] = [];
  for (const item of data.items) {
    records.push(await citation(job, item.citation.citationId));
  }
  const characterBudget = job.tokenBudget * 4;
  let usedCharacters = 0;
  const selected: Array<{ citationId: string; text: string }> = [];
  for (const item of data.items) {
    const text = item.segment.content || `${item.segment.question}\n${item.segment.answer}`.trim();
    const remaining = characterBudget - usedCharacters;
    if (remaining <= 0) break;
    const part = text.slice(0, remaining);
    selected.push({ citationId: item.citation.citationId, text: part });
    usedCharacters += part.length;
  }
  return {
    ...result,
    citationIds: data.items.map((item) => item.citation.citationId),
    citationRecords: records,
    citationQuoteFieldsPresent: records.every((item) =>
      Object.prototype.hasOwnProperty.call(item, 'quote'),
    ),
    context: selected,
    contextCharacters: usedCharacters,
    stopReason: data.partial
      ? 'partial_dependency'
      : data.items.length === 0
        ? 'empty'
        : selected.length === data.items.length
          ? 'completed'
          : 'token_budget',
  };
}

async function importConsumer(job: ConsumerJob) {
  const body = job.importBody ?? {};
  const response = await request(
    job,
    `/v1/knowledge/spaces/${encodeURIComponent(job.knowledgeSpaceId)}/imports/text`,
    {
      method: 'POST',
      body,
      idempotencyKey: job.requestId,
    },
  );
  const accepted = successEnvelope(response, (value) => {
    if (typeof value !== 'object' || value === null) throw new Error('invalid import response');
    return value as { jobId?: string; id?: string; status?: string; [key: string]: unknown };
  });
  if (!accepted.ok) return accepted;
  const jobId = String(accepted.data.jobId ?? accepted.data.id ?? '');
  if (!jobId) return { ok: false as const, status: accepted.status, missingJobId: true };
  const deadline = Date.now() + 90_000;
  let current: JobView | null = null;
  while (Date.now() < deadline) {
    const polled = await request(job, `/v1/knowledge/jobs/${encodeURIComponent(jobId)}`);
    const jobResult = successEnvelope(polled, (value) => value as JobView);
    if (!jobResult.ok) return jobResult;
    current = jobResult.data;
    if (['succeeded', 'failed', 'dead_letter', 'cancelled'].includes(current.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!current) return { ok: false as const, status: 504, timedOut: true, jobId };
  const sources = await request(
    job,
    `/v1/knowledge/spaces/${encodeURIComponent(job.knowledgeSpaceId)}/sources?limit=200`,
  );
  const sourceResult = successEnvelope(sources, (value) => value as Record<string, unknown>);
  return {
    ok: current.status === 'succeeded' && sourceResult.ok,
    acceptedStatus: accepted.status,
    job: current,
    sources: sourceResult.ok ? sourceResult.data : null,
    traceId: accepted.traceId,
    requestId: accepted.requestId,
    stopReason: current.status,
  };
}

async function main() {
  if (!key) throw new Error('KB_B18_API_KEY is required');
  const raw = process.argv[2] === '--stdin' ? await readAllStdin() : (process.argv[2] ?? '');
  const job = JSON.parse(raw) as ConsumerJob;
  switch (job.role) {
    case 'workflow':
      return workflow(job);
    case 'agent':
      return agent(job);
    case 'chat':
      return chat(job);
    case 'import':
      return importConsumer(job);
    default:
      throw new Error('unknown consumer role');
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const issue =
    typeof error === 'object' && error !== null && 'problem' in error
      ? {
          status: Reflect.get(error, 'status'),
          problem: safeProblem(Reflect.get(error, 'problem')),
        }
      : { message: error instanceof Error ? error.message : String(error) };
  process.stdout.write(`${JSON.stringify({ ok: false, consumerError: issue })}\n`);
}
