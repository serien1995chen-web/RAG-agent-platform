/**
 * P4-04 externalFile 来源 Provider（设计 8.1.1 / 11.7）。
 * PDF Provider 走 PdfEnhanceProviderPort（upload/poll/parse/cancel）mock 合同；未配置 501062。
 */
import type {
  DatasetSourceProvider,
  PdfEnhanceProviderPort,
  SourceReadRequest,
  SourceReadResult,
} from '../../../../ports/capabilities';
import type { RequestContext } from '../../../../ports/types';
import { hashSourceText, sourceError } from './link-provider';

export interface ExternalProviderDeps {
  pdfProvider?: PdfEnhanceProviderPort;
  configured: boolean;
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function createExternalSourceProvider(deps: ExternalProviderDeps): DatasetSourceProvider {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = deps.pollIntervalMs ?? 500;
  const maxPolls = deps.maxPolls ?? 20;

  const read = async (
    request: SourceReadRequest,
    context: RequestContext,
  ): Promise<SourceReadResult> => {
    if (!deps.configured || !deps.pdfProvider) {
      throw sourceError(501062, context.requestId, { dependency: 'pdf_enhance_provider' });
    }
    const provider = deps.pdfProvider;
    try {
      const uploaded = await provider.upload(
        { ref: { bucket: 'kb-source', key: request.sourceRef }, options: request.options },
        context,
      );
      let result = await provider.parse(
        { providerTaskId: uploaded.providerTaskId, options: request.options },
        context,
      );
      let polls = 0;
      while (result.state === 'pending' && polls < maxPolls) {
        await sleep(pollIntervalMs);
        result = await provider.poll(
          { providerTaskId: uploaded.providerTaskId, options: request.options },
          context,
        );
        polls += 1;
      }
      if (result.state !== 'done' || typeof result.text !== 'string') {
        throw sourceError(501039, context.requestId, {
          provider: 'pdf_enhance',
          status: result.state,
        });
      }
      return { rawText: result.text, contentHash: hashSourceText(result.text) };
    } catch (error) {
      if (error instanceof Error && error.name === 'ApiErrorException') throw error;
      throw sourceError(501039, context.requestId, { provider: 'pdf_enhance', status: 'error' });
    }
  };
  return { read, preview: read };
}
