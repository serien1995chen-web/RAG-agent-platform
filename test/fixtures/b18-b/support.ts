import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createProbeServer } from 'node:net';
import { join, resolve } from 'node:path';
import {
  createKnowledgeConnections,
  KnowledgeFullTextRepository,
  KnowledgeJobExecutionRepository,
  KnowledgeSegmentIndexRepository,
  KnowledgeVectorRepository,
  loadKnowledgeRuntimeConfig,
  registerKnowledgeModels,
  S06ProcessingApplication,
  S5MockModelCatalog,
  S5ProcessingApplication,
  S6ProcessingRepository,
  type KnowledgeConnections,
  type TenantContext,
} from '../../../packages/service/src/index';
import { MinioKnowledgeObjectStore } from '../../../sdk/storage/src/providers/minio';

const root = resolve(import.meta.dirname, '../../..');
const appRoot = join(root, 'projects', 'app');

export interface B18AppHarness {
  baseUrl: string;
  output(): string;
  close(): Promise<void>;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
  traceId?: string;
  requestId?: string;
}

export interface ApiKeySecret {
  id: string;
  keyPrefix: string;
  secret: string;
  scopes: string[];
  spaceIds: string[];
  version: number;
}

export interface ConsumerJob {
  role: 'workflow' | 'agent' | 'chat' | 'import';
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

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required B18 environment: ${name}`);
  return value;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function suffix(prefix = 'b18b'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function redact(value: string, secrets: readonly string[] = []): string {
  let output = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/kn_live_[A-Za-z0-9_-]{20,}/g, 'kn_live_[REDACTED]')
    .replace(
      /(authorization|cookie|api[-_]?key|secret|token)\s*[:=]\s*[^\s,;}]+/gi,
      '$1=[REDACTED]',
    );
  for (const secret of secrets.filter(Boolean)) {
    output = output.replaceAll(secret, '[REDACTED]');
  }
  return output;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createProbeServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no B18 test port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

function runtimeEnv(input: {
  suffix: string;
  workspaceId: string;
  memberId: string;
  authToken: string;
  scopes?: string;
  isWorkspaceOwner?: boolean;
  port: number;
  modelMode?: 'mock' | 'real';
  aiproxyBaseUrl?: string;
  extraEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const base = {
    ...process.env,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    KB_ENV: 'test',
    KB_APP_WORKER_MODE: 'http',
    KB_PORT: String(input.port),
    KB_INSTANCE_ID: `b18b-${input.suffix}`,
    KB_MONGO_URI: requiredEnv('KB_TEST_MONGO_URI'),
    KB_REDIS_URL: requiredEnv('KB_TEST_REDIS_URL'),
    KB_PG_URL: requiredEnv('KB_TEST_PG_URL'),
    KB_S3_ENDPOINT: requiredEnv('KB_TEST_S3_ENDPOINT'),
    KB_S3_REGION: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
    KB_S3_BUCKET: requiredEnv('KB_TEST_S3_BUCKET'),
    KB_S3_ACCESS_KEY_REF: 'env:KB_B18B_S3_ACCESS',
    KB_S3_SECRET_KEY_REF: 'env:KB_B18B_S3_SECRET',
    KB_B18B_S3_ACCESS: requiredEnv('KB_TEST_S3_ACCESS_KEY'),
    KB_B18B_S3_SECRET: requiredEnv('KB_TEST_S3_SECRET_KEY'),
    KB_FILE_PUBLIC_BASE_URL: `http://127.0.0.1:${input.port}`,
    KB_FILE_TICKET_SECRET_REF: 'env:KB_B18B_TICKET_SECRET',
    KB_B18B_TICKET_SECRET: `b18b-ticket-${input.suffix}-value`,
    KB_CREDENTIAL_ENCRYPTION_KEY_REF: 'env:KB_B18B_CREDENTIAL_KEY',
    KB_B18B_CREDENTIAL_KEY: `b18b-credential-${input.suffix}-value`,
    KB_CITATION_SIGNING_SECRET_REF: 'env:KB_B18B_CITATION_SECRET',
    KB_B18B_CITATION_SECRET: `b18b-citation-${input.suffix}-value`,
    KB_AUTH_MODE: 'mock',
    KB_MOCK_AUTH_TOKEN: input.authToken,
    API_KEY_HMAC_SECRET_FILE: `${root}/test/fixtures/s10/api-key-hmac.secret`,
    KB_MOCK_WORKSPACE_ID: input.workspaceId,
    KB_MOCK_MEMBER_ID: input.memberId,
    KB_MOCK_SCOPES:
      input.scopes ?? 'knowledge:read,knowledge:write,knowledge:manage,knowledge:admin',
    KB_MOCK_WORKSPACE_OWNER: String(input.isWorkspaceOwner ?? true),
    KB_EXTERNAL_MODEL_MODE: input.modelMode ?? 'mock',
    KB_EXTERNAL_OCR_MODE: 'mock',
    KB_EXTERNAL_CONNECTOR_MODE: 'mock',
    KB_LOG_LEVEL: 'error',
  } satisfies NodeJS.ProcessEnv;
  if (input.modelMode === 'real') {
    return {
      ...base,
      AIPROXY_MODE: 'openai',
      AIPROXY_BASE_URL:
        input.aiproxyBaseUrl ??
        (() => {
          throw new Error('AIPROXY_BASE_URL is required when modelMode=real');
        })(),
      AIPROXY_API_TOKEN: `b18b-local-provider-${input.suffix}`,
      AIPROXY_MODEL_PROFILE_JSON: JSON.stringify({
        models: [
          {
            id: 'mock-embedding-768',
            type: 'embedding',
            capabilities: ['text-embedding', 'dimension:768'],
            dimension: 768,
          },
          {
            id: 'mock-rerank',
            type: 'rerank',
            capabilities: ['rerank'],
          },
          {
            id: 'mock-embedding-1024',
            type: 'embedding',
            capabilities: ['text-embedding', 'dimension:1024'],
            dimension: 1024,
          },
          {
            id: 'mock-llm-general',
            type: 'llm',
            capabilities: ['chat'],
          },
        ],
      }),
      S11_AIPROXY_MODEL_MAPPING_APPROVED: 'true',
      ...input.extraEnv,
    };
  }
  return { ...base, ...input.extraEnv };
}

async function waitForHttp(
  handle: ChildProcess,
  baseUrl: string,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (handle.exitCode !== null) throw new Error(`B18 app exited early\n${output()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // App is still booting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`B18 app did not become healthy\n${output()}`);
}

async function waitForWorker(
  worker: ChildProcess,
  marker: string,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error(`B18 worker exited early\n${output()}`);
    if (existsSync(marker)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`B18 worker did not become ready\n${output()}`);
}

export async function startB18App(input: {
  suffix: string;
  workspaceId: string;
  memberId: string;
  authToken: string;
  scopes?: string;
  isWorkspaceOwner?: boolean;
  withWorker?: boolean;
  modelMode?: 'mock' | 'real';
  aiproxyBaseUrl?: string;
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<B18AppHarness> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const nextBinary = join(appRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBinary)) throw new Error(`Next binary missing: ${nextBinary}`);
  const workerMarker = `/tmp/knowledge-worker-ready-${input.suffix}-${process.pid}`;
  let output = '';
  const collect = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-30_000);
  };
  const app = spawn(process.execPath, [nextBinary, 'start', '-p', String(port)], {
    cwd: appRoot,
    env: runtimeEnv({ ...input, port }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout?.on('data', collect);
  app.stderr?.on('data', collect);
  await waitForHttp(app, baseUrl, () => output);
  let worker: ChildProcess | null = null;
  if (input.withWorker) {
    const workerEntry = join(appRoot, 'dist', 'workers', 'worker.mjs');
    if (!existsSync(workerEntry)) throw new Error(`worker build missing: ${workerEntry}`);
    rmSync(workerMarker, { force: true });
    worker = spawn(process.execPath, [workerEntry], {
      cwd: appRoot,
      env: {
        ...runtimeEnv({ ...input, port }),
        KB_APP_WORKER_MODE: 'worker',
        KB_INSTANCE_ID: `b18b-worker-${input.suffix}`,
        KB_WORKER_READY_FILE: workerMarker,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    worker.stdout?.on('data', collect);
    worker.stderr?.on('data', collect);
    await waitForWorker(worker, workerMarker, () => output);
  }
  return {
    baseUrl,
    output: () => redact(output),
    async close() {
      if (worker && worker.exitCode === null) {
        worker.kill('SIGTERM');
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
        if (worker.exitCode === null) worker.kill('SIGKILL');
      }
      rmSync(workerMarker, { force: true });
      if (app.exitCode === null) {
        app.kill('SIGTERM');
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
        if (app.exitCode === null) app.kill('SIGKILL');
      }
    },
  };
}

export async function apiRequest<T = unknown>(
  app: Pick<B18AppHarness, 'baseUrl'>,
  path: string,
  input: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    token?: string | null;
    workspaceId: string;
    requestId?: string;
    body?: unknown;
    idempotencyKey?: string;
    headers?: Record<string, string>;
  },
): Promise<{ response: Response; payload: ApiEnvelope<T>; text: string }> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method: input.method ?? 'GET',
    headers: {
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      'x-workspace-id': input.workspaceId,
      ...(input.requestId ? { 'x-request-id': input.requestId } : {}),
      ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...input.headers,
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const text = await response.text();
  let payload = {} as ApiEnvelope<T>;
  try {
    payload = text ? (JSON.parse(text) as ApiEnvelope<T>) : ({} as ApiEnvelope<T>);
  } catch {
    payload = {} as ApiEnvelope<T>;
  }
  return { response, payload, text };
}

export async function createSpace(
  app: Pick<B18AppHarness, 'baseUrl'>,
  input: {
    adminToken: string;
    workspaceId: string;
    suffix: string;
    parentSpaceId?: string | null;
  },
): Promise<{ id: string; version: number; referenceRevision: number }> {
  const result = await apiRequest(app, '/v1/knowledge/spaces', {
    method: 'POST',
    token: input.adminToken,
    workspaceId: input.workspaceId,
    idempotencyKey: `b18b-space-${input.suffix}`,
    body: {
      kind: 'space',
      parentSpaceId: input.parentSpaceId ?? null,
      name: `B18B ${input.suffix}`,
      description: `B18-B downstream fixture ${input.suffix}`,
      iconKey: 'book-open',
      accessMode: 'workspace',
      sourceAclMode: 'enforced',
      sourcePermissionEnabled: true,
    },
  });
  if (!result.response.ok || result.payload.success !== true || !result.payload.data) {
    throw new Error(`createSpace failed: ${result.response.status} ${result.text}`);
  }
  return result.payload.data as { id: string; version: number; referenceRevision: number };
}

export async function createSourceAndSegment(
  app: Pick<B18AppHarness, 'baseUrl'>,
  input: {
    adminToken: string;
    workspaceId: string;
    spaceId: string;
    suffix: string;
    title: string;
    text: string;
  },
): Promise<{ sourceId: string; segmentId: string }> {
  const source = await apiRequest<{ id: string }>(
    app,
    `/v1/knowledge/spaces/${input.spaceId}/sources`,
    {
      method: 'POST',
      token: input.adminToken,
      workspaceId: input.workspaceId,
      idempotencyKey: `b18b-source-${input.suffix}`,
      body: {
        kind: 'text',
        name: input.title,
        searchEnabled: true,
        metadata: {},
      },
    },
  );
  if (!source.payload.success || !source.payload.data?.id) {
    throw new Error(`createSource failed: ${source.response.status} ${source.text}`);
  }
  const segment = await apiRequest<{ id: string }>(
    app,
    `/v1/knowledge/sources/${source.payload.data.id}/segments`,
    {
      method: 'POST',
      token: input.adminToken,
      workspaceId: input.workspaceId,
      idempotencyKey: `b18b-segment-${input.suffix}`,
      body: {
        question: input.title,
        answer: input.text,
        searchEnabled: true,
        metadata: { title: input.title },
      },
    },
  );
  if (!segment.payload.success || !segment.payload.data?.id) {
    throw new Error(`createSegment failed: ${segment.response.status} ${segment.text}`);
  }
  return { sourceId: source.payload.data.id, segmentId: segment.payload.data.id };
}

export async function openConnections(): Promise<KnowledgeConnections> {
  const config = loadKnowledgeRuntimeConfig({
    ...process.env,
    API_KEY_HMAC_SECRET_FILE: `${root}/test/fixtures/s10/api-key-hmac.secret`,
    KB_MONGO_URI: requiredEnv('KB_TEST_MONGO_URI'),
    KB_REDIS_URL: requiredEnv('KB_TEST_REDIS_URL'),
    KB_PG_URL: requiredEnv('KB_TEST_PG_URL'),
    KB_S3_ENDPOINT: requiredEnv('KB_TEST_S3_ENDPOINT'),
    KB_S3_BUCKET: requiredEnv('KB_TEST_S3_BUCKET'),
    KB_S3_ACCESS_KEY_REF: 'env:KB_B18B_CONNECTION_S3_ACCESS',
    KB_S3_SECRET_KEY_REF: 'env:KB_B18B_CONNECTION_S3_SECRET',
  });
  return createKnowledgeConnections(config);
}

export async function cleanupWorkspaceObjects(
  connections: KnowledgeConnections,
  workspaceId: string,
): Promise<{ refs: number; deleted: number; failed: number }> {
  const models = registerKnowledgeModels(connections.mongo);
  const refs = (await models.KnowledgeObjectRef.find({
    workspaceId,
    deletedAt: null,
  })
    .select({ knowledgeSpaceId: 1, objectKey: 1, upload: 1 })
    .lean()) as Array<{
    knowledgeSpaceId: unknown;
    objectKey: string;
    upload?: { finalObjectKey?: string | null };
  }>;
  const endpoint = new URL(requiredEnv('KB_TEST_S3_ENDPOINT'));
  const store = new MinioKnowledgeObjectStore({
    provider: 'minio',
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey: requiredEnv('KB_TEST_S3_ACCESS_KEY'),
    secretKey: requiredEnv('KB_TEST_S3_SECRET_KEY'),
    region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
    bucket: requiredEnv('KB_TEST_S3_BUCKET'),
  });
  let deleted = 0;
  let failed = 0;
  for (const ref of refs) {
    const keys = [
      ...new Set([ref.objectKey, ref.upload?.finalObjectKey].filter(Boolean)),
    ] as string[];
    for (const objectKey of keys) {
      try {
        await store.deleteObject(objectKey, {
          workspaceId,
          knowledgeSpaceId: String(ref.knowledgeSpaceId),
          requestId: 'b18b-cleanup',
          traceId: `b18b-cleanup-${workspaceId}`,
        });
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { refs: refs.length, deleted, failed };
}

export async function seedIndexedSegment(
  connections: KnowledgeConnections,
  context: TenantContext,
  input: { spaceId: string; segmentId: string; text: string; label: string },
): Promise<void> {
  const models = registerKnowledgeModels(connections.mongo);
  await models.KnowledgeModelBinding.deleteMany({
    workspaceId: context.workspaceId,
    knowledgeSpaceId: new connections.mongo.base.Types.ObjectId(input.spaceId),
  });
  await models.KnowledgeModelBinding.create({
    workspaceId: context.workspaceId,
    knowledgeSpaceId: new connections.mongo.base.Types.ObjectId(input.spaceId),
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    modelType: 'embedding',
    modelId: 'mock-embedding-768',
    displayName: 'B18 mock embedding 768',
    requiredCapabilities: ['text-embedding', 'dimension:768'],
    status: 'active',
    activeQueryModelId: 'mock-embedding-768',
    activeQueryDimension: 768,
    authorizedAt: new Date(),
  });
  const jobs = new KnowledgeJobExecutionRepository(connections.mongo);
  const catalog = new S5MockModelCatalog();
  const indexes = new KnowledgeSegmentIndexRepository(connections.mongo, jobs, catalog);
  await indexes.upsert(
    input.segmentId,
    {
      indexId: 'primary',
      type: 'custom',
      text: input.text,
      modelId: 'mock-embedding-768',
      version: 1,
    },
    'create',
    context,
  );
  const job = await models.KnowledgeJob.findOne({
    workspaceId: context.workspaceId,
    kind: 'index',
    resourceId: input.segmentId,
  }).lean();
  if (!job) throw new Error(`B18 index job missing for ${input.label}`);
  const processing = new S06ProcessingApplication({
    jobs,
    store: new S6ProcessingRepository(connections.mongo),
    artifacts: {
      async materialize() {
        throw new Error('not used by B18 index fixture');
      },
    },
    processing: new S5ProcessingApplication(),
    vectors: new KnowledgeVectorRepository(connections.pg),
    fulltext: new KnowledgeFullTextRepository(connections.mongo),
    models: catalog,
    bindings: {
      async list() {
        return [
          {
            modelType: 'embedding',
            modelId: 'mock-embedding-768',
            displayName: 'B18 mock embedding 768',
            requiredCapabilities: ['text-embedding', 'dimension:768'],
            status: 'active',
          },
        ];
      },
    },
    port: {
      async parse() {
        throw new Error('not used by B18 index fixture');
      },
      async embed() {
        return [Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0))];
      },
      async dispatchOutbox() {
        return true;
      },
    },
  });
  const outcome = await processing.handleQueue(
    'knowledge-index',
    String(job._id),
    `b18b-worker-${context.requestId}`,
    context,
  );
  if (outcome !== 'succeeded') throw new Error(`B18 index seed failed for ${input.label}`);
}

export async function setEmbeddingBinding(
  connections: KnowledgeConnections,
  context: TenantContext,
  input: { spaceId: string; modelId: string; dimension: 768 | 1024 | 1536 | 3072 },
): Promise<void> {
  const models = registerKnowledgeModels(connections.mongo);
  await models.KnowledgeModelBinding.deleteMany({
    workspaceId: context.workspaceId,
    knowledgeSpaceId: new connections.mongo.base.Types.ObjectId(input.spaceId),
  });
  await models.KnowledgeModelBinding.create({
    workspaceId: context.workspaceId,
    knowledgeSpaceId: new connections.mongo.base.Types.ObjectId(input.spaceId),
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    modelType: 'embedding',
    modelId: input.modelId,
    displayName: `B18 ${input.modelId}`,
    requiredCapabilities: ['text-embedding', `dimension:${input.dimension}`],
    status: 'active',
    activeQueryModelId: input.modelId,
    activeQueryDimension: input.dimension,
    authorizedAt: new Date(),
  });
}

export async function createApiKey(
  app: Pick<B18AppHarness, 'baseUrl'>,
  input: {
    adminToken: string;
    workspaceId: string;
    suffix: string;
    scopes: string[];
    spaceIds?: string[];
    expiresAt?: string | null;
  },
): Promise<ApiKeySecret> {
  const result = await apiRequest<ApiKeySecret>(app, '/v1/knowledge/api-keys', {
    method: 'POST',
    token: input.adminToken,
    workspaceId: input.workspaceId,
    idempotencyKey: `b18b-key-${input.suffix}`,
    body: {
      name: `B18B ${input.suffix}`,
      scopes: input.scopes,
      spaceIds: input.spaceIds ?? [],
      expiresAt: input.expiresAt ?? null,
    },
  });
  if (!result.response.ok || result.payload.success !== true || !result.payload.data?.secret) {
    throw new Error(`createApiKey failed: ${result.response.status} ${result.text}`);
  }
  return result.payload.data;
}

export async function spawnConsumer(
  job: ConsumerJob,
  secret: string,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(root, 'test/fixtures/b18-b/consumer-entry.ts'), '--stdin'],
    {
      cwd: root,
      env: { ...process.env, KB_B18_API_KEY: secret, NEXT_TELEMETRY_DISABLED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout = `${stdout}${chunk.toString()}`.slice(-100_000);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-30_000);
  });
  child.stdin?.end(`${JSON.stringify(job)}\n`);
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`B18 consumer timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code ?? -1);
    });
  });
  const safeStderr = redact(stderr, [secret]);
  if (exitCode !== 0) {
    throw new Error(`B18 consumer exited ${exitCode}: ${safeStderr}`);
  }
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error(`B18 consumer produced no JSON: ${safeStderr}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`B18 consumer produced invalid JSON: ${redact(stdout, [secret])}`);
  }
  if (redact(JSON.stringify(parsed), [secret]).includes(secret)) {
    throw new Error('B18 consumer leaked the API Key');
  }
  return parsed as Record<string, unknown>;
}

export async function startConsumerPage(input: {
  appBaseUrl: string;
  workspaceId: string;
  apiKey: string;
}): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const html = readFileSync(join(root, 'test/fixtures/b18-b/consumer-page.html'), 'utf8');
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (!request.url) {
      response.writeHead(400).end();
      return;
    }
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/consumer-page.html') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(html);
      return;
    }
    if (!url.pathname.startsWith('/v1/knowledge/')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: false, error: { code: 'TEST_PATH_BLOCKED' } }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    const target = new URL(url.pathname + url.search, `${input.appBaseUrl}/`);
    const upstream = await fetch(target, {
      method: request.method ?? 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${input.apiKey}`,
        'x-workspace-id': input.workspaceId,
        'x-request-id':
          (Array.isArray(request.headers['x-request-id'])
            ? request.headers['x-request-id'][0]
            : request.headers['x-request-id']) ?? `b18b-page-${randomUUID()}`,
        traceparent:
          (Array.isArray(request.headers.traceparent)
            ? request.headers.traceparent[0]
            : request.headers.traceparent) ??
          `00-${randomUUID().replaceAll('-', '').padEnd(32, '0')}-${randomUUID()
            .replaceAll('-', '')
            .slice(0, 16)}-01`,
        ...(request.headers['content-type']
          ? { 'content-type': String(request.headers['content-type']) }
          : {}),
        ...(request.headers['idempotency-key']
          ? { 'idempotency-key': String(request.headers['idempotency-key']) }
          : {}),
      },
      ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    const headers: Record<string, string> = {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    };
    for (const name of [
      'x-request-id',
      'x-trace-id',
      'ratelimit-limit',
      'ratelimit-remaining',
      'ratelimit-reset',
      'retry-after',
    ]) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    response.writeHead(upstream.status, headers);
    response.end(body);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('consumer page server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}

export async function delayedProvider(input: {
  delayMs: number;
}): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          data: [{ id: 'mock-embedding-768' }, { id: 'mock-rerank' }, { id: 'mock-llm-general' }],
        }),
      );
      return;
    }
    if (request.url === '/v1/embeddings') {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, input.delayMs));
      response.writeHead(504, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          data: Array.from({ length: 1 }, () => ({
            embedding: Array.from({ length: 768 }, () => 0),
          })),
        }),
      );
      return;
    }
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'controlled provider unavailable' } }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('controlled provider did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}

export async function partialProvider(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          data: [
            { id: 'mock-embedding-768' },
            { id: 'mock-embedding-1024' },
            { id: 'mock-rerank' },
            { id: 'mock-llm-general' },
          ],
        }),
      );
      return;
    }
    if (request.url === '/v1/embeddings') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model?: string;
        input?: string | string[];
      };
      if (body.model === 'mock-embedding-1024') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'controlled partial-space failure' } }));
        return;
      }
      const inputs = Array.isArray(body.input) ? body.input : [String(body.input ?? '')];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          data: inputs.map((_, index) => ({
            index,
            embedding: Array.from({ length: 768 }, (__, itemIndex) => (itemIndex === 0 ? 1 : 0)),
          })),
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        }),
      );
      return;
    }
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'controlled provider unavailable' } }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('partial provider did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}
