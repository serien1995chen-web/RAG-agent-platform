import { createHash } from 'node:crypto';
import { createKnowledgeError, KnowledgeApiError } from '@kb/contracts';
import type { TenantContext } from '../../../../shared/persistence/knowledge/tenant';

export interface S11ConnectorHttpRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

export interface S11ConnectorHttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  data: T;
}

export interface S11ConnectorHttpTransport {
  request<T = unknown>(input: S11ConnectorHttpRequest): Promise<S11ConnectorHttpResponse<T>>;
}

export interface S11ConnectorRetryPolicy {
  delaysMs: readonly number[];
  retryOnServerError: boolean;
}

export interface S11ConnectorHttpEvidence {
  provider: string;
  method: S11ConnectorHttpRequest['method'];
  endpointPath: string;
  endpointHost: string;
  requestId: string;
  traceId: string;
  status: number | null;
  attempt: number;
  durationMs: number;
  safeErrorCode: string | null;
}

const FEISHU_RETRY_POLICY: S11ConnectorRetryPolicy = {
  delaysMs: [5_000, 10_000, 20_000, 40_000],
  retryOnServerError: true,
};

const DINGTALK_RETRY_POLICY: S11ConnectorRetryPolicy = {
  delaysMs: [5_000],
  retryOnServerError: false,
};

export function connectorRetryPolicy(
  provider: 'feishu' | 'yuque' | 'dingtalk',
): S11ConnectorRetryPolicy {
  return provider === 'dingtalk' ? DINGTALK_RETRY_POLICY : FEISHU_RETRY_POLICY;
}

export function safeEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return '[invalid-endpoint]';
  }
}

export function safeEndpointPath(endpoint: string): string {
  try {
    const pathname = new URL(endpoint).pathname;
    const apiStart = pathname.indexOf('/api/v2');
    const providerPath = apiStart >= 0 ? pathname.slice(apiStart) : pathname;
    return providerPath
      .replace(
        /^\/open-apis\/docx\/v1\/documents\/[^/]+/,
        '/open-apis/docx/v1/documents/:documentId',
      )
      .replace(/^\/api\/v2\/groups\/[^/]+/, '/api/v2/groups/:groupId')
      .replace(/^\/api\/v2\/repos\/[^/]+/, '/api/v2/repos/:repoId')
      .replace(/(\/api\/v2\/repos\/:repoId\/docs)\/[^/]+/, '$1/:docSlug')
      .replace(/^\/v2\.0\/wiki\/nodes\/[^/]+/, '/v2.0/wiki/nodes/:nodeId');
  } catch {
    return '[invalid-path]';
  }
}

export function connectorCredentialDigest(
  provider: string,
  workspaceId: string,
  credentials: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(`${provider}\0${workspaceId}\0${JSON.stringify(credentials)}`)
    .digest('hex');
}

export function isProviderStatus(error: unknown, status: number): boolean {
  return (
    error instanceof KnowledgeApiError &&
    Number(error.problem.error.details.providerStatus) === status
  );
}

export class FetchS11ConnectorHttpTransport implements S11ConnectorHttpTransport {
  async request<T = unknown>(input: S11ConnectorHttpRequest): Promise<S11ConnectorHttpResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const body =
        input.body === undefined
          ? undefined
          : typeof input.body === 'string' || input.body instanceof Uint8Array
            ? input.body
            : JSON.stringify(input.body);
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        ...(body === undefined ? {} : { body: body as unknown as string }),
        signal: controller.signal,
        redirect: 'error',
      });
      const contentType = response.headers.get('content-type') ?? '';
      const data = contentType.includes('application/json')
        ? await response.json()
        : await response.text();
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        data: data as T,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class S11ConnectorTokenCache {
  private readonly values = new Map<string, { token: string; expiresAt: number }>();

  async getOrLoad(
    key: string,
    loader: () => Promise<{ token: string; expiresInSeconds: number }>,
  ): Promise<string> {
    const cached = this.values.get(key);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
    const loaded = await loader();
    this.values.set(key, {
      token: loaded.token,
      expiresAt: Date.now() + Math.max(60, loaded.expiresInSeconds) * 1_000,
    });
    return loaded.token;
  }

  invalidate(key: string): void {
    this.values.delete(key);
  }
}

export class S11ConnectorHttpClient {
  readonly evidence: S11ConnectorHttpEvidence[] = [];

  constructor(
    private readonly input: {
      provider: 'feishu' | 'yuque' | 'dingtalk';
      transport: S11ConnectorHttpTransport;
      sleep: (ms: number) => Promise<void>;
      retryPolicy?: S11ConnectorRetryPolicy;
    },
  ) {}

  async request<T = unknown>(
    request: Omit<S11ConnectorHttpRequest, 'timeoutMs'> & { timeoutMs?: number },
    context: TenantContext,
  ): Promise<S11ConnectorHttpResponse<T>> {
    const policy = this.input.retryPolicy ?? connectorRetryPolicy(this.input.provider);
    const startedAt = Date.now();
    let attempt = 0;
    let lastStatus: number | null = null;
    for (;;) {
      attempt += 1;
      try {
        const response = await this.input.transport.request<T>({
          ...request,
          timeoutMs: request.timeoutMs ?? 30_000,
        });
        lastStatus = response.status;
        this.record(request, context, response.status, attempt, startedAt, null);
        if (response.status === 401 || response.status === 403) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
            requestId: context.requestId,
            traceId: context.traceId,
            retryable: false,
            details: {
              provider: this.input.provider,
              providerStatus: response.status,
              errorKind: response.status === 401 ? 'auth' : 'permission',
            },
          });
        }
        if (response.status === 404) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_NOT_FOUND',
            requestId: context.requestId,
            traceId: context.traceId,
            retryable: false,
            details: {
              provider: this.input.provider,
              providerStatus: 404,
              errorKind: 'not_found',
            },
          });
        }
        if (response.status === 429) {
          const delay = policy.delaysMs[attempt - 1];
          if (delay !== undefined) {
            await this.input.sleep(delay);
            continue;
          }
          throw createKnowledgeError({
            code: 'KNOWLEDGE_RATE_LIMITED',
            requestId: context.requestId,
            traceId: context.traceId,
            retryable: true,
            details: {
              provider: this.input.provider,
              providerStatus: 429,
              attempts: attempt,
            },
          });
        }
        if (response.status >= 500) {
          const delay =
            policy.retryOnServerError && policy.delaysMs[attempt - 1] !== undefined
              ? policy.delaysMs[attempt - 1]
              : undefined;
          if (delay !== undefined) {
            await this.input.sleep(delay);
            continue;
          }
          throw createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
            requestId: context.requestId,
            traceId: context.traceId,
            retryable: true,
            details: {
              provider: this.input.provider,
              providerStatus: response.status,
              attempts: attempt,
            },
          });
        }
        if (response.status < 200 || response.status >= 300) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
            requestId: context.requestId,
            traceId: context.traceId,
            retryable: false,
            details: {
              provider: this.input.provider,
              providerStatus: response.status,
              errorKind: 'unknown',
            },
          });
        }
        return response;
      } catch (error) {
        if (error instanceof KnowledgeApiError) throw error;
        const aborted =
          error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
        const delay = aborted ? policy.delaysMs[attempt - 1] : undefined;
        if (delay !== undefined) {
          await this.input.sleep(delay);
          continue;
        }
        const code = aborted
          ? ('KNOWLEDGE_DEPENDENCY_TIMEOUT' as const)
          : ('KNOWLEDGE_DEPENDENCY_UNAVAILABLE' as const);
        this.record(
          request,
          context,
          null,
          attempt,
          startedAt,
          aborted ? 'timeout' : 'network_error',
        );
        throw createKnowledgeError({
          code,
          requestId: context.requestId,
          traceId: context.traceId,
          retryable: true,
          details: {
            provider: this.input.provider,
            providerStatus: lastStatus,
            errorKind: aborted ? 'timeout' : 'network_error',
          },
        });
      }
    }
  }

  private record(
    request: Omit<S11ConnectorHttpRequest, 'timeoutMs'> & { timeoutMs?: number },
    context: TenantContext,
    status: number | null,
    attempt: number,
    startedAt: number,
    safeErrorCode: string | null,
  ): void {
    this.evidence.push({
      provider: this.input.provider,
      method: request.method,
      endpointPath: safeEndpointPath(request.url),
      endpointHost: safeEndpointHost(request.url),
      requestId: context.requestId,
      traceId: context.traceId,
      status,
      attempt,
      durationMs: Date.now() - startedAt,
      safeErrorCode,
    });
  }
}

export async function parseConnectorResponse<T>(
  request: () => Promise<S11ConnectorHttpResponse<unknown>>,
  parse: (data: unknown) => T,
  input: {
    provider: string;
    context: TenantContext;
  },
): Promise<{ response: S11ConnectorHttpResponse<unknown>; parsed: T }> {
  let response = await request();
  try {
    return { response, parsed: parse(response.data) };
  } catch {
    response = await request();
    try {
      return { response, parsed: parse(response.data) };
    } catch {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID',
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        retryable: true,
        details: {
          provider: input.provider,
          providerStatus: response.status,
          schemaRetries: 1,
        },
      });
    }
  }
}
