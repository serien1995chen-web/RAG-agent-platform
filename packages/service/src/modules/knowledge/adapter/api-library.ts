import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createKnowledgeError, KnowledgeApiError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type {
  CustomApiClientPort,
  ProviderCatalogResult,
  ProviderContent,
} from '../application/ingestion.ports';
import {
  dependencyStatusError,
  providerContractError,
  validateCustomApiConfiguration,
} from './provider-json';
import { validateUrlTarget, type VettedUrlTarget } from './ssrf';

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5000;

export interface JsonHttpResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export type JsonRequester = (
  url: string,
  input: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: unknown;
    timeoutMs: number;
    maxBytes?: number;
    context: TenantContext;
  },
) => Promise<JsonHttpResponse>;

interface RawHttpResponse {
  status: number;
  location: string | null;
  headers: Record<string, string>;
  bytes: Uint8Array;
}

async function requestPinnedOnce(
  target: VettedUrlTarget,
  input: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: unknown;
    timeoutMs: number;
    maxBytes: number;
    context: TenantContext;
  },
): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const payload =
      input.method === 'POST' && input.body !== undefined ? JSON.stringify(input.body) : undefined;
    const request = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      work();
    };
    const requestInstance = request(
      target.url,
      {
        method: input.method,
        headers: {
          accept: 'application/json',
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(payload)),
              }
            : {}),
          ...input.headers,
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, target.address, target.family);
        },
        servername: target.url.hostname,
        timeout: Math.min(CONNECT_TIMEOUT_MS, input.timeoutMs),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location =
          typeof response.headers.location === 'string' ? response.headers.location : null;
        if (status >= 300 && status < 400) {
          response.resume();
          finish(() =>
            resolve({
              status,
              location,
              headers: {},
              bytes: new Uint8Array(),
            }),
          );
          return;
        }
        const declaredLength = Number(response.headers['content-length'] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > input.maxBytes) {
          requestInstance.destroy();
          finish(() => {
            reject(
              createKnowledgeError({
                code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
                requestId: input.context.requestId,
                traceId: input.context.traceId,
                details: { provider: 'custom_api', limitBytes: input.maxBytes },
              }),
            );
          });
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > input.maxBytes) {
            requestInstance.destroy();
            finish(() => {
              reject(
                createKnowledgeError({
                  code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
                  requestId: input.context.requestId,
                  traceId: input.context.traceId,
                  details: { provider: 'custom_api', limitBytes: input.maxBytes },
                }),
              );
            });
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          finish(() =>
            resolve({
              status,
              location,
              headers: Object.fromEntries(
                Object.entries(response.headers).map(([key, value]) => [
                  key,
                  Array.isArray(value) ? value.join(',') : String(value ?? ''),
                ]),
              ),
              bytes: Buffer.concat(chunks),
            }),
          );
        });
        response.on('error', (error) => finish(() => reject(error)));
      },
    );
    const totalTimer = setTimeout(() => {
      requestInstance.destroy(
        createKnowledgeError({
          code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
          requestId: input.context.requestId,
          traceId: input.context.traceId,
          details: { provider: 'custom_api', timeoutMs: input.timeoutMs },
        }),
      );
    }, input.timeoutMs);
    requestInstance.on('timeout', () => {
      requestInstance.destroy(
        createKnowledgeError({
          code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
          requestId: input.context.requestId,
          traceId: input.context.traceId,
          details: { provider: 'custom_api', timeoutMs: CONNECT_TIMEOUT_MS },
        }),
      );
    });
    requestInstance.on('error', (error) =>
      finish(() => {
        if (error instanceof KnowledgeApiError) {
          reject(error);
          return;
        }
        reject(
          createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { provider: 'custom_api' },
          }),
        );
      }),
    );
    if (payload) requestInstance.write(payload);
    requestInstance.end();
  });
}

export function createPinnedJsonRequester(
  options: {
    resolve?: typeof validateUrlTarget;
    requestOnce?: typeof requestPinnedOnce;
  } = {},
): JsonRequester {
  const resolve = options.resolve ?? validateUrlTarget;
  const request = options.requestOnce ?? requestPinnedOnce;
  return async (url, input) => {
    const deadline = Date.now() + input.timeoutMs;
    let current = url;
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const target = await resolve(current, input.context);
      const response = await request(target, {
        ...input,
        maxBytes: input.maxBytes ?? MAX_RESPONSE_BYTES,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      if (response.status >= 300 && response.status < 400) {
        if (redirect === MAX_REDIRECTS) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
            requestId: input.context.requestId,
            traceId: input.context.traceId,
            details: { provider: 'custom_api', reason: 'redirect_limit' },
          });
        }
        if (!response.location) {
          providerContractError('custom_api', input.context, 'redirect_location_missing');
        }
        current = new URL(response.location, target.url).toString();
        continue;
      }
      const text = Buffer.from(response.bytes).toString('utf8');
      let body: unknown = null;
      try {
        body = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        providerContractError('custom_api', input.context, 'json_response_invalid');
      }
      return { status: response.status, headers: response.headers, body };
    }
    return providerContractError('custom_api', input.context, 'redirect_limit');
  };
}

function authHeaders(credentials: Record<string, unknown>): Record<string, string> {
  const mode = String(credentials.authMode ?? 'none');
  if (mode === 'none') return {};
  const authorization = String(credentials.authorization ?? '');
  return mode === 'api_key'
    ? { 'x-api-key': authorization }
    : { authorization: `Bearer ${authorization}` };
}

function checkResponse(
  response: JsonHttpResponse,
  context: TenantContext,
): Record<string, unknown> {
  if (response.status === 401 || response.status === 403) {
    return dependencyStatusError('custom_api', response.status, context);
  }
  if (response.status === 409) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_CURSOR_INVALID',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { provider: 'custom_api' },
    });
  }
  if (response.status === 413) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { provider: 'custom_api' },
    });
  }
  if (response.status === 429) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_RATE_LIMITED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: {
        provider: 'custom_api',
        retryAfterSeconds: Number(response.headers?.['retry-after'] ?? 0),
      },
    });
  }
  if (response.status >= 500) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { provider: 'custom_api', providerStatus: response.status },
    });
  }
  if (response.status < 200 || response.status >= 300) {
    return providerContractError('custom_api', context, `http_${response.status}`);
  }
  if (response.body === null || typeof response.body !== 'object' || Array.isArray(response.body)) {
    return providerContractError('custom_api', context, 'object_response_required');
  }
  return response.body as Record<string, unknown>;
}

function baseUrlOf(
  config: Record<string, unknown>,
  path: string,
  query: Record<string, string> = {},
): string {
  const base = new URL(String(config.baseUrl));
  const basePath = String(config.basePath ?? '').replace(/\/+$/, '');
  base.pathname = `${base.pathname.replace(/\/+$/, '')}${basePath}${path}`;
  base.search = '';
  base.hash = '';
  for (const [key, value] of Object.entries(query)) base.searchParams.set(key, value);
  return base.toString();
}

function catalogBody(
  config: Record<string, unknown>,
  input: { parentId: string; cursor?: string; offset?: number },
): Record<string, unknown> {
  const base = { parentId: input.parentId };
  if (config.pageMode === 'cursor') return { ...base, cursor: input.cursor ?? null };
  if (config.pageMode === 'offset') return { ...base, offset: input.offset ?? 0 };
  return base;
}

export class CustomApiLibraryClient implements CustomApiClientPort {
  constructor(private readonly requester: JsonRequester = createPinnedJsonRequester()) {}

  async catalog(input: {
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    parentId: string;
    cursor?: string;
    offset?: number;
    context: TenantContext;
  }): Promise<ProviderCatalogResult> {
    const validated = validateCustomApiConfiguration(
      input.config,
      input.credentials,
      input.context,
    );
    const response = await this.requester(baseUrlOf(validated.config, '/v1/file/list'), {
      method: 'POST',
      headers: authHeaders(validated.credentials),
      body: catalogBody(validated.config, input),
      timeoutMs: 30_000,
      context: input.context,
    });
    const body = checkResponse(response, input.context);
    if (!Array.isArray(body.items)) {
      return providerContractError('custom_api', input.context, 'catalog_items_array_required');
    }
    const items = body.items.map((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        return providerContractError('custom_api', input.context, 'catalog_item_invalid');
      }
      const record = item as Record<string, unknown>;
      if (
        typeof record.id !== 'string' ||
        typeof record.name !== 'string' ||
        (record.type !== 'directory' && record.type !== 'document')
      ) {
        return providerContractError('custom_api', input.context, 'catalog_item_invalid');
      }
      return {
        id: record.id,
        name: record.name,
        type: record.type,
      } as const;
    });
    return {
      provider: 'custom',
      items,
      ...(typeof body.nextCursor === 'string' ? { nextCursor: body.nextCursor } : {}),
    };
  }

  async content(input: {
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    fileIds: readonly string[];
    context: TenantContext;
  }): Promise<ProviderContent[]> {
    const validated = validateCustomApiConfiguration(
      input.config,
      input.credentials,
      input.context,
    );
    const results: ProviderContent[] = [];
    for (const fileId of input.fileIds) {
      const detail = await this.requester(
        baseUrlOf(validated.config, '/v1/file/detail', { fileId }),
        {
          method: 'GET',
          headers: authHeaders(validated.credentials),
          timeoutMs: 30_000,
          context: input.context,
        },
      );
      const detailBody = checkResponse(detail, input.context);
      const content = await this.requester(
        baseUrlOf(validated.config, '/v1/file/content', { fileId }),
        {
          method: 'GET',
          headers: authHeaders(validated.credentials),
          timeoutMs: 30_000,
          context: input.context,
        },
      );
      const contentBody = checkResponse(content, input.context);
      if (typeof contentBody.content !== 'string' || contentBody.content.trim().length === 0) {
        providerContractError('custom_api', input.context, 'content_non_empty_string_required');
      }
      results.push({
        externalId: fileId,
        title:
          typeof detailBody.name === 'string'
            ? detailBody.name
            : typeof contentBody.name === 'string'
              ? contentBody.name
              : fileId,
        mimeType:
          typeof detailBody.mimeType === 'string'
            ? detailBody.mimeType
            : 'text/plain; charset=utf-8',
        bytes: Buffer.from(contentBody.content, 'utf8'),
      });
    }
    return results;
  }
}
