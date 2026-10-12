/**
 * P4-04 apiFile 来源 Provider（设计 8.1.1 / 11.6）。
 * 第三方目录/文件接口（axios）；未配置返回 501062 且不发请求；失败 501039。
 * BASE-B2：扩展 getCatalog/getPathNames/list，未配置 501017、能力缺失 501019、失败 501039；
 * 现有 read 行为保持不变。
 */
import { createHash } from 'node:crypto';
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
import type { PortCallOptions, RequestContext } from '../../../../ports/types';
import { hashSourceText, sourceError } from './link-provider';

/** 每次调用按请求 apiConfig 解析出的端点/凭证/超时，供注入客户端使用。 */
export interface ApiDatasetClientCallOptions {
  provider: ApiDatasetConfig['provider'];
  credentialRef: string;
  endpointRef?: string;
  baseUrl?: string;
  timeoutMs: number;
}

export interface ApiDatasetHttpClient {
  get(
    url: string,
    options: { timeout: number; responseType: 'text' },
  ): Promise<{ status: number; data: string }>;
  getCatalog?(
    request: ApiDatasetCatalogRequest,
    options: ApiDatasetClientCallOptions,
  ): Promise<JsonValue[]>;
  getPathNames?(
    request: ApiDatasetPathNamesRequest,
    options: ApiDatasetClientCallOptions,
  ): Promise<string>;
  list?(request: ApiDatasetListRequest, options: ApiDatasetClientCallOptions): Promise<JsonValue[]>;
}

export interface ApiDatasetProviderDeps {
  client?: ApiDatasetHttpClient;
  /** 可选：按请求 apiConfig 选择客户端；返回 undefined 时回退到 client。 */
  resolveClient?: (config: ApiDatasetConfig) => ApiDatasetHttpClient | undefined;
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

/** 稳定序列化（键排序），用于配置身份哈希，避免不同 JSON 键序导致缓存击穿。 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(',')}}`;
}

/**
 * API Dataset 配置身份哈希：同一 team/dataset 下只有配置完全一致才允许复用目录缓存，
 * 防止不同 endpoint/credential/capabilities 之间串用缓存。
 */
export function apiDatasetConfigIdentity(config: ApiDatasetConfig): string {
  const identity = canonicalize({
    provider: config.provider,
    endpointRef: config.endpointRef ?? '',
    credentialRef: config.credentialRef,
    capabilities: config.capabilities.map((capability) => ({
      name: capability.name,
      supported: capability.supported,
      constraints: capability.constraints ?? null,
    })),
  });
  return `sha256:${createHash('sha256').update(identity).digest('hex')}`;
}

/** 超时按请求 apiConfig.timeoutMs 优先，缺省回退调用方 options.timeoutMs。 */
function resolveTimeoutMs(config: ApiDatasetConfig, options: PortCallOptions): number {
  return config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : options.timeoutMs;
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
    const client = deps.resolveClient?.(config) ?? deps.client;
    if (!deps.configured || !client || !config.credentialRef) {
      throw sourceError(501017, context.requestId, { provider: config.provider });
    }
    return client;
  };

  const clientOptions = (
    config: ApiDatasetConfig,
    options: PortCallOptions,
  ): ApiDatasetClientCallOptions => ({
    provider: config.provider,
    credentialRef: config.credentialRef,
    endpointRef: config.endpointRef,
    baseUrl: deps.baseUrl,
    timeoutMs: resolveTimeoutMs(config, options),
  });

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
      method.call(client, request, clientOptions(request.apiConfig, request.options)),
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
      method.call(client, request, clientOptions(request.apiConfig, request.options)),
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
      method.call(client, request, clientOptions(request.apiConfig, request.options)),
    );
  };

  return { read, preview: read, getCatalog, getPathNames, list };
}
