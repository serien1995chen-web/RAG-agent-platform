/**
 * P4-04 text 来源 Provider（设计 8.1.1 / 9.4）。
 * 直接返回 rawText 与 contentHash；空文本在读取阶段放行，空导入语义由 P4-05 决定。
 */
import type {
  DatasetSourceProvider,
  SourceReadRequest,
  SourceReadResult,
} from '../../../../ports/capabilities';
import type { RequestContext } from '../../../../ports/types';
import { hashSourceText } from './link-provider';

export function createTextSourceProvider(): DatasetSourceProvider {
  const read = async (
    request: SourceReadRequest,
    _context: RequestContext,
  ): Promise<SourceReadResult> => {
    const rawText = request.sourceRef;
    return { rawText, contentHash: hashSourceText(rawText) };
  };
  return { read, preview: read };
}
