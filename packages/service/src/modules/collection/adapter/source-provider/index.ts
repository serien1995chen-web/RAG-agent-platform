/**
 * P4-04 来源 Provider 选择器（设计 8.1.1 / 9.4）。
 * sourceType → Provider；未登记类型抛稳定错误；未配置 Provider 不得发起任何外部请求。
 */
import type { JsonValue } from '@kb/contracts';
import type {
  ApiDatasetCatalogRequest,
  ApiDatasetConfig,
  ApiDatasetListRequest,
  ApiDatasetPathNamesRequest,
  DatasetSourceProvider,
  ObjectStorePort,
  PdfEnhanceProviderPort,
  SourceReadRequest,
  SourceReadResult,
} from '../../../../ports/capabilities';
import type { RequestContext } from '../../../../ports/types';
import {
  apiDatasetConfigIdentity,
  createApiDatasetSourceProvider,
  type ApiDatasetHttpClient,
} from './api-dataset-provider';
import { createExternalSourceProvider } from './external-provider';
import { createFileSourceProvider, type FileParserLike } from './file-provider';
import { createLinkSourceProvider, type LinkLimits, type LinkFetcher } from './link-provider';
import { sourceError, type SourceAuditSink } from './link-provider';
import { createTextSourceProvider } from './text-provider';

export { createTextSourceProvider } from './text-provider';
export { createFileSourceProvider } from './file-provider';
export type { FileParserLike, FileSourceProviderDeps } from './file-provider';
export { createLinkSourceProvider, DEFAULT_LINK_LIMITS, isBlockedAddress } from './link-provider';
export { createApiDatasetSourceProvider } from './api-dataset-provider';
export { apiDatasetConfigIdentity } from './api-dataset-provider';
export type { ApiDatasetClientCallOptions } from './api-dataset-provider';
export { createExternalSourceProvider } from './external-provider';
export { hashSourceText, hashUrl } from './link-provider';

export const SOURCE_PROVIDER_TYPES = ['file', 'link', 'text', 'apiFile', 'externalFile'] as const;
export type SourceProviderType = (typeof SOURCE_PROVIDER_TYPES)[number];

export interface SourceProviderRegistryDeps {
  objectStore?: ObjectStorePort;
  fileParser?: FileParserLike;
  linkFetcher?: LinkFetcher;
  resolveHost?: (hostname: string) => Promise<string[]>;
  linkLimits?: Partial<LinkLimits>;
  /** 链接安全审计出口；只记 urlHash/host/结果分类。 */
  audit?: SourceAuditSink;
  apiDataset?: {
    configured: boolean;
    client?: ApiDatasetHttpClient;
    resolveClient?: (config: ApiDatasetConfig) => ApiDatasetHttpClient | undefined;
    baseUrl?: string;
  };
  pdfProvider?: PdfEnhanceProviderPort;
  pdfProviderConfigured?: boolean;
  /** U-25：mock 合同开关与运行环境。 */
  mock?: boolean;
  environment?: string;
}

export class SourceProviderRegistry {
  private readonly providers = new Map<string, DatasetSourceProvider>();
  private readonly catalogCache = new Map<string, { expiresAt: number; value: JsonValue[] }>();
  private static readonly CATALOG_TTL_MS = 5 * 60 * 1000;

  constructor(deps: SourceProviderRegistryDeps = {}) {
    this.providers.set('text', createTextSourceProvider());
    if (deps.objectStore && deps.fileParser) {
      this.providers.set(
        'file',
        createFileSourceProvider({ objectStore: deps.objectStore, parser: deps.fileParser }),
      );
    }
    this.providers.set(
      'link',
      createLinkSourceProvider({
        fetcher: deps.linkFetcher,
        resolveHost: deps.resolveHost,
        limits: deps.linkLimits,
        audit: deps.audit,
      }),
    );
    this.providers.set(
      'apiFile',
      createApiDatasetSourceProvider({
        configured: deps.apiDataset?.configured ?? false,
        client: deps.apiDataset?.client,
        resolveClient: deps.apiDataset?.resolveClient,
        baseUrl: deps.apiDataset?.baseUrl,
      }),
    );
    this.providers.set(
      'externalFile',
      createExternalSourceProvider({
        configured: deps.pdfProviderConfigured ?? false,
        pdfProvider: deps.pdfProvider,
        mock: deps.mock,
        environment: deps.environment,
      }),
    );
  }

  resolve(sourceType: string): DatasetSourceProvider | null {
    return this.providers.get(sourceType) ?? null;
  }

  read(request: SourceReadRequest, context: RequestContext): Promise<SourceReadResult> {
    const provider = this.resolve(request.sourceType);
    if (!provider) {
      throw sourceError(501035, context.requestId, {
        contentType: request.sourceType,
        urlHash: '',
      });
    }
    return provider.read(request, context);
  }

  preview(request: SourceReadRequest, context: RequestContext): Promise<SourceReadResult> {
    const provider = this.resolve(request.sourceType);
    if (!provider) {
      throw sourceError(501035, context.requestId, {
        contentType: request.sourceType,
        urlHash: '',
      });
    }
    return provider.preview(request, context);
  }

  async getCatalog(
    request: ApiDatasetCatalogRequest,
    context: RequestContext,
  ): Promise<JsonValue[]> {
    const provider = this.resolve('apiFile');
    const method = provider?.getCatalog;
    if (!provider || !method) {
      throw sourceError(501019, context.requestId, {
        provider: request.apiConfig.provider,
        status: 'not_implemented',
      });
    }
    const cacheKey = [
      context.tenant.teamId,
      request.datasetId,
      apiDatasetConfigIdentity(request.apiConfig),
      request.parentId ?? '',
    ].join('|');
    const now = Date.now();
    const cached = this.catalogCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = await method.call(provider, request, context);
    this.catalogCache.set(cacheKey, {
      expiresAt: now + SourceProviderRegistry.CATALOG_TTL_MS,
      value,
    });
    return value;
  }

  getPathNames(request: ApiDatasetPathNamesRequest, context: RequestContext): Promise<string> {
    const provider = this.resolve('apiFile');
    const method = provider?.getPathNames;
    if (!provider || !method) {
      throw sourceError(501019, context.requestId, {
        provider: request.apiConfig.provider,
        status: 'not_implemented',
      });
    }
    return method.call(provider, request, context);
  }

  list(request: ApiDatasetListRequest, context: RequestContext): Promise<JsonValue[]> {
    const provider = this.resolve('apiFile');
    const method = provider?.list;
    if (!provider || !method) {
      throw sourceError(501019, context.requestId, {
        provider: request.apiConfig.provider,
        status: 'not_implemented',
      });
    }
    return method.call(provider, request, context);
  }
}

export function createSourceProviderRegistry(
  deps: SourceProviderRegistryDeps = {},
): SourceProviderRegistry {
  return new SourceProviderRegistry(deps);
}
