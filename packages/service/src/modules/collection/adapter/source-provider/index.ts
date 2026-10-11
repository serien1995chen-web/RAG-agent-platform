/**
 * P4-04 来源 Provider 选择器（设计 8.1.1 / 9.4）。
 * sourceType → Provider；未登记类型抛稳定错误；未配置 Provider 不得发起任何外部请求。
 */
import type {
  DatasetSourceProvider,
  ObjectStorePort,
  PdfEnhanceProviderPort,
  SourceReadRequest,
  SourceReadResult,
} from '../../../../ports/capabilities';
import type { RequestContext } from '../../../../ports/types';
import { createApiDatasetSourceProvider, type ApiDatasetHttpClient } from './api-dataset-provider';
import { createExternalSourceProvider } from './external-provider';
import { createFileSourceProvider, type FileParserLike } from './file-provider';
import { createLinkSourceProvider, type LinkLimits, type LinkFetcher } from './link-provider';
import { sourceError } from './link-provider';
import { createTextSourceProvider } from './text-provider';

export { createTextSourceProvider } from './text-provider';
export { createFileSourceProvider } from './file-provider';
export type { FileParserLike, FileSourceProviderDeps } from './file-provider';
export { createLinkSourceProvider, DEFAULT_LINK_LIMITS, isBlockedAddress } from './link-provider';
export { createApiDatasetSourceProvider } from './api-dataset-provider';
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
  apiDataset?: { configured: boolean; client?: ApiDatasetHttpClient; baseUrl?: string };
  pdfProvider?: PdfEnhanceProviderPort;
  pdfProviderConfigured?: boolean;
}

export class SourceProviderRegistry {
  private readonly providers = new Map<string, DatasetSourceProvider>();

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
      }),
    );
    this.providers.set(
      'apiFile',
      createApiDatasetSourceProvider({
        configured: deps.apiDataset?.configured ?? false,
        client: deps.apiDataset?.client,
        baseUrl: deps.apiDataset?.baseUrl,
      }),
    );
    this.providers.set(
      'externalFile',
      createExternalSourceProvider({
        configured: deps.pdfProviderConfigured ?? false,
        pdfProvider: deps.pdfProvider,
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
}

export function createSourceProviderRegistry(
  deps: SourceProviderRegistryDeps = {},
): SourceProviderRegistry {
  return new SourceProviderRegistry(deps);
}
