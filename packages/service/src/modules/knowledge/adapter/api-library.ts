import { createKnowledgeError } from '@kb/contracts';
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
import { validateUrlTarget } from './ssrf';

export interface JsonHttpResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export type JsonRequester = (
  url: string,
  input: {
    method: 'POST';
    headers: Record<string, string>;
    body: unknown;
    timeoutMs: number;
  },
) => Promise<JsonHttpResponse>;

async function defaultRequester(
  url: string,
  input: {
    method: 'POST';
    headers: Record<string, string>;
    body: unknown;
    timeoutMs: number;
  },
): Promise<JsonHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(url, {
      method: input.method,
      headers: input.headers,
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as unknown;
    return {
      status: response.status,
      body,
      headers: Object.fromEntries(response.headers.entries()),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
        requestId: 'provider',
        traceId: 'provider',
        details: { provider: 'custom_api', timeoutMs: input.timeoutMs },
      });
    }
    throw createKnowledgeError({
      code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
      requestId: 'provider',
      traceId: 'provider',
      details: { provider: 'custom_api' },
    });
  } finally {
    clearTimeout(timer);
  }
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
  if (response.status < 200 || response.status >= 300) {
    return providerContractError('custom_api', context, `http_${response.status}`);
  }
  if (response.body === null || typeof response.body !== 'object' || Array.isArray(response.body)) {
    return providerContractError('custom_api', context, 'object_response_required');
  }
  return response.body as Record<string, unknown>;
}

function baseUrlOf(config: Record<string, unknown>, path: string): string {
  const base = new URL(String(config.baseUrl));
  const basePath = String(config.basePath ?? '').replace(/\/+$/, '');
  base.pathname = `${base.pathname.replace(/\/+$/, '')}${basePath}${path}`;
  base.search = '';
  base.hash = '';
  return base.toString();
}

export class CustomApiLibraryClient implements CustomApiClientPort {
  constructor(private readonly requester: JsonRequester = defaultRequester) {}

  async catalog(input: {
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
    parentId: string;
    cursor?: string;
    context: TenantContext;
  }): Promise<ProviderCatalogResult> {
    const validated = validateCustomApiConfiguration(
      input.config,
      input.credentials,
      input.context,
    );
    await validateUrlTarget(String(validated.config.baseUrl), input.context);
    const response = await this.requester(baseUrlOf(validated.config, '/v1/file/list'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...authHeaders(validated.credentials),
      },
      body: { parentId: input.parentId, cursor: input.cursor ?? null },
      timeoutMs: 30_000,
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
    await validateUrlTarget(String(validated.config.baseUrl), input.context);
    const results: ProviderContent[] = [];
    for (const fileId of input.fileIds) {
      const detail = await this.requester(baseUrlOf(validated.config, '/v1/file/detail'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...authHeaders(validated.credentials),
        },
        body: { fileId },
        timeoutMs: 30_000,
      });
      const detailBody = checkResponse(detail, input.context);
      const content = await this.requester(baseUrlOf(validated.config, '/v1/file/content'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...authHeaders(validated.credentials),
        },
        body: { fileId },
        timeoutMs: 30_000,
      });
      const contentBody = checkResponse(content, input.context);
      if (typeof contentBody.content !== 'string') {
        providerContractError('custom_api', input.context, 'content_string_required');
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
        bytes: Buffer.from(String(contentBody.content), 'utf8'),
      });
    }
    return results;
  }
}
