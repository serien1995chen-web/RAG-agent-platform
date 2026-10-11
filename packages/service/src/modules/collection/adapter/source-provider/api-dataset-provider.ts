/**
 * P4-04 apiFile 来源 Provider（设计 8.1.1 / 11.6）。
 * 第三方目录/文件接口（axios）；未配置返回 501062 且不发请求；失败 501039。
 */
import type {
  DatasetSourceProvider,
  SourceReadRequest,
  SourceReadResult,
} from '../../../../ports/capabilities';
import type { RequestContext } from '../../../../ports/types';
import { hashSourceText, sourceError } from './shared';

export interface ApiDatasetHttpClient {
  get(
    url: string,
    options: { timeout: number; responseType: 'text' },
  ): Promise<{ status: number; data: string }>;
}

export interface ApiDatasetProviderDeps {
  client?: ApiDatasetHttpClient;
  configured: boolean;
  baseUrl?: string;
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
      const status =
        typeof error === 'object' && error !== null
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
      throw sourceError(501039, context.requestId, {
        provider: 'api_dataset',
        status: status ?? 'error',
      });
    }
  };
  return { read, preview: read };
}
