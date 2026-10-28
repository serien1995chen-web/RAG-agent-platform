import {
  CitationApiSchema,
  KnowledgeProblemSchema,
  MultiSpaceSearchApiRequestSchema,
  SearchApiRequestSchema,
  SearchApiResponseSchema,
  type CitationApi,
  type KnowledgeProblem,
  type MultiSpaceSearchApiRequest,
  type SearchApiRequest,
  type SearchApiResponse,
} from '@kb/contracts';

export interface S7DownstreamKnowledgeClientOptions {
  baseUrl: string;
  workspaceId: string;
  credential: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  requestIdFactory?: () => string;
}

export interface S7DownstreamRequestOptions {
  requestId?: string;
  traceId?: string;
  signal?: AbortSignal;
}

export interface S7DownstreamResult<T> {
  status: 200 | 207;
  data: T;
  traceId: string;
  requestId: string;
}

export class S7DownstreamKnowledgeError extends Error {
  constructor(
    readonly status: number,
    readonly problem: KnowledgeProblem,
  ) {
    super(problem.error.message);
    this.name = 'S7DownstreamKnowledgeError';
  }
}

export class S7DownstreamNetworkError extends Error {
  constructor(
    readonly kind: 'timeout' | 'transport' | 'response',
    override readonly cause: unknown,
  ) {
    super(`Knowledge downstream ${kind} failure`);
    this.name = 'S7DownstreamNetworkError';
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function traceParent(requestId: string): string {
  const normalized = requestId
    .replace(/[^a-f0-9]/gi, '')
    .toLowerCase()
    .padEnd(32, '0')
    .slice(0, 32);
  const span = normalized.slice(-16);
  return `00-${normalized}-${span}-01`;
}

export class S7DownstreamKnowledgeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly requestIdFactory: () => string;

  constructor(private readonly options: S7DownstreamKnowledgeClientOptions) {
    if (!options.workspaceId.trim()) throw new S7DownstreamNetworkError('transport', 'workspace');
    if (!options.credential.trim()) throw new S7DownstreamNetworkError('transport', 'credential');
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.requestIdFactory = options.requestIdFactory ?? (() => globalThis.crypto.randomUUID());
  }

  private async request<T>(
    path: string,
    input: {
      method: 'GET' | 'POST';
      body?: unknown;
      options?: S7DownstreamRequestOptions;
      parse: (value: unknown) => T;
    },
  ): Promise<S7DownstreamResult<T>> {
    if (!path.startsWith('/v1/knowledge/')) {
      throw new S7DownstreamNetworkError('transport', 'path');
    }
    const requestId = input.options?.requestId ?? this.requestIdFactory();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), this.timeoutMs);
    const externalSignal = input.options?.signal;
    const forwardAbort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: input.method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.options.credential}`,
          'x-workspace-id': this.options.workspaceId,
          'x-request-id': requestId,
          traceparent: traceParent(input.options?.traceId ?? requestId),
          ...(input.method === 'POST' ? { 'idempotency-key': requestId } : {}),
          ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: controller.signal,
      });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new S7DownstreamNetworkError('response', error);
      }
      if (
        !response.ok ||
        (typeof payload === 'object' &&
          payload !== null &&
          (payload as { success?: unknown }).success === false)
      ) {
        const parsed = KnowledgeProblemSchema.safeParse(payload);
        if (!parsed.success) throw new S7DownstreamNetworkError('response', parsed.error);
        throw new S7DownstreamKnowledgeError(response.status, parsed.data);
      }
      if (typeof payload !== 'object' || payload === null) {
        throw new S7DownstreamNetworkError('response', 'envelope');
      }
      const envelope = payload as {
        success?: unknown;
        data?: unknown;
        traceId?: unknown;
        requestId?: unknown;
      };
      if (
        envelope.success !== true ||
        typeof envelope.traceId !== 'string' ||
        typeof envelope.requestId !== 'string'
      ) {
        throw new S7DownstreamNetworkError('response', 'envelope');
      }
      return {
        status: response.status === 207 ? 207 : 200,
        data: input.parse(envelope.data),
        traceId: envelope.traceId,
        requestId: envelope.requestId,
      };
    } catch (error) {
      if (
        error instanceof S7DownstreamKnowledgeError ||
        error instanceof S7DownstreamNetworkError
      ) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new S7DownstreamNetworkError('timeout', error);
      }
      throw new S7DownstreamNetworkError('transport', error);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', forwardAbort);
    }
  }

  searchSemantic(
    request: SearchApiRequest,
    options?: S7DownstreamRequestOptions,
  ): Promise<S7DownstreamResult<SearchApiResponse>> {
    return this.search('/v1/knowledge/search/semantic', request, 'semantic', options);
  }

  searchFulltext(
    request: SearchApiRequest,
    options?: S7DownstreamRequestOptions,
  ): Promise<S7DownstreamResult<SearchApiResponse>> {
    return this.search('/v1/knowledge/search/full-text', request, 'fulltext', options);
  }

  searchHybrid(
    request: SearchApiRequest,
    options?: S7DownstreamRequestOptions,
  ): Promise<S7DownstreamResult<SearchApiResponse>> {
    return this.search('/v1/knowledge/search/hybrid', request, 'hybrid', options);
  }

  private search(
    path: string,
    request: SearchApiRequest,
    mode: 'semantic' | 'fulltext' | 'hybrid',
    options?: S7DownstreamRequestOptions,
  ): Promise<S7DownstreamResult<SearchApiResponse>> {
    const parsed = SearchApiRequestSchema.parse(request);
    if (parsed.searchMode !== undefined && parsed.searchMode !== mode) {
      return Promise.reject(new S7DownstreamNetworkError('transport', 'mode_mismatch'));
    }
    return this.request(path, {
      method: 'POST',
      body: parsed,
      ...(options ? { options } : {}),
      parse: (value) => SearchApiResponseSchema.parse(value),
    });
  }

  searchMultiSpace(
    request: MultiSpaceSearchApiRequest,
    options?: S7DownstreamRequestOptions,
  ): Promise<S7DownstreamResult<SearchApiResponse>> {
    const parsed = MultiSpaceSearchApiRequestSchema.parse(request);
    return this.request('/v1/knowledge/search/multi-space', {
      method: 'POST',
      body: parsed,
      ...(options ? { options } : {}),
      parse: (value) => SearchApiResponseSchema.parse(value),
    });
  }

  getCitation(
    citationId: string,
    options?: S7DownstreamRequestOptions,
  ): Promise<S7DownstreamResult<CitationApi>> {
    return this.request(`/v1/knowledge/citations/${encodeURIComponent(citationId)}`, {
      method: 'GET',
      ...(options ? { options } : {}),
      parse: (value) => CitationApiSchema.parse(value),
    });
  }
}
