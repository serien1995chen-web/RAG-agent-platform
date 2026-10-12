/**
 * P4-04 apiFile 来源 Provider（设计 8.1.1 / 11.6）。
 * 第三方目录/文件接口（axios）；未配置返回 501062 且不发请求；失败 501039。
 * BASE-B2：扩展 getCatalog/getPathNames/list，未配置 501017、能力缺失 501019、失败 501039；
 * 现有 read 行为保持不变。
 */
import { ApiErrorException } from '@kb/contracts';
import type { JsonValue } from '@kb/contracts';
import type {
  ApiDatasetCatalogRequest,
  ApiDatasetConfig,
  ApiDatasetListRequest,
  ApiDatasetPathNamesRequest,
  DatasetSourceProvider,
  SourceReadRequest,
  SourceReadResult,
} from '../../../../ports/capabilities';
import type { RequestContext } from '../../../../ports/types';
import { hashSourceText, sourceError } from './link-provider';

export interface ApiDatasetHttpClient {
  get(
    url: string,
    options: { timeout: number; responseType: 'text' },
  ): Promise<{ status: number; data: string }>;
  getCatalog?(
    request: ApiDatasetCatalogRequest,
    options: { baseUrl?: string; timeoutMs: number },
  ): Promise<JsonValue[]>;
  getPathNames?(
    request: ApiDatasetPathNamesRequest,
    options: { baseUrl?: string; timeoutMs: number },
  ): Promise<string>;
  list?(
    request: ApiDatasetListRequest,
    options: { baseUrl?: string; timeoutMs: number },
  ): Promise<JsonValue[]>;
}

export interface ApiDatasetProviderDeps {
  client?: ApiDatasetHttpClient;
  configured: boolean;
  baseUrl?: string;
}

type ApiDatasetOperation = 'getCatalog' | 'getPathNames' | 'list';

function statusOf(error: unknown): number | string {
  const status =
    typeof error === 'object' && error !== null
      ? (error as { response?: { status?: number } }).response?.status
      : undefined;
  return status ?? 'error';
}

function capabilityDeclared(config: ApiDatasetConfig, operation: ApiDatasetOperation): boolean {
  return config.capabilities.some(
    (capability) => capability.supported && capability.name === operation,
  );
}

export function createApiDatasetSourceProvider(
  deps: ApiDatasetProviderDeps,
): DatasetSourceProvider {
  const read = async (
    request: SourceReadRequest,
    context: RequestContext,
  ): Promise<SourceReadResult> => {
    if (!deps.configured || !deps.client) {
      throw sourceError(501062, context.requestId, { dependency: 'api_dataset_provider' });
    }
    const url = deps.baseUrl ? deps.baseUrl + request.sourceRef : request.sourceRef;
    try {
      const response = await deps.client.get(url, {
        timeout: request.options.timeoutMs,
        responseType: 'text',
      });
      return { rawText: response.data, contentHash: hashSourceText(response.data) };
    } catch (error) {
      throw sourceError(501039, context.requestId, {
        provider: 'api_dataset',
        status: statusOf(error),
      });
    }
  };

  const requireClient = (
    context: RequestContext,
    config: ApiDatasetConfig,
  ): ApiDatasetHttpClient => {
    if (!deps.configured || !deps.client) {
      throw sourceError(501017, context.requestId, { provider: config.provider });
    }
    return deps.client;
  };

  const requireCapability = (
    context: RequestContext,
    config: ApiDatasetConfig,
    operation: ApiDatasetOperation,
  ): void => {
    if (!capabilityDeclared(config, operation)) {
      throw sourceError(501019, context.requestId, {
        provider: config.provider,
        status: 'capability_missing',
      });
    }
  };

  const callClient = async <T>(
    context: RequestContext,
    config: ApiDatasetConfig,
    work: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiErrorException) throw error;
      throw sourceError(501039, context.requestId, {
        provider: `api_dataset:${config.provider}`,
        status: statusOf(error),
      });
    }
  };

  const getCatalog = async (
    request: ApiDatasetCatalogRequest,
    context: RequestContext,
  ): Promise<JsonValue[]> => {
    const client = requireClient(context, request.apiConfig);
    requireCapability(context, request.apiConfig, 'getCatalog');
    const method = client.getCatalog;
    if (!method) {
      throw sourceError(501019, context.requestId, {
        provider: request.apiConfig.provider,
        status: 'not_implemented',
      });
    }
    return callClient(context, request.apiConfig, () =>
      method.call(client, request, { baseUrl: deps.baseUrl, timeoutMs: request.options.timeoutMs }),
    );
  };

  const getPathNames = async (
    request: ApiDatasetPathNamesRequest,
    context: RequestContext,
  ): Promise<string> => {
    const client = requireClient(context, request.apiConfig);
    requireCapability(context, request.apiConfig, 'getPathNames');
    const method = client.getPathNames;
    if (!method) {
      throw sourceError(501019, context.requestId, {
        provider: request.apiConfig.provider,
        status: 'not_implemented',
      });
    }
    return callClient(context, request.apiConfig, () =>
      method.call(client, request, { baseUrl: deps.baseUrl, timeoutMs: request.options.timeoutMs }),
    );
  };

  const list = async (
    request: ApiDatasetListRequest,
    context: RequestContext,
  ): Promise<JsonValue[]> => {
    const client = requireClient(context, request.apiConfig);
    requireCapability(context, request.apiConfig, 'list');
    const method = client.list;
    if (!method) {
      throw sourceError(501019, context.requestId, {
        provider: request.apiConfig.provider,
        status: 'not_implemented',
      });
    }
    return callClient(context, request.apiConfig, () =>
      method.call(client, request, { baseUrl: deps.baseUrl, timeoutMs: request.options.timeoutMs }),
    );
  };

  return { read, preview: read, getCatalog, getPathNames, list };
}
