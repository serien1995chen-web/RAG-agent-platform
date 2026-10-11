import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { MAX_RAW_TEXT_BYTES, apiError } from '../../../../../shared/import-source';
import { objectStoreOf } from '../../../../../shared/object-store';

interface PreviewChunksBody {
  fileRef?: string;
  rawText?: string;
  chunkPolicy?: { chunkSize?: number; overlapRatio?: number };
}

/** API-FILE-004 POST /api/core/dataset/file/previewChunks */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as import('../../../../../runtime').ExtendedAppRuntime;
    await authenticateRequest(runtime, request, requestId);
    const body = parseDto<PreviewChunksBody>('PreviewChunksBody', request.body);
    let rawText = body.rawText ?? '';
    if (rawText.length === 0 && body.fileRef) {
      const store = objectStoreOf(runtime);
      if (store) {
        const fetched = await store.get(
          { ref: { bucket: 'kb-source', key: body.fileRef } },
          await authenticateRequest(runtime, request, requestId).then((auth) => auth.context),
        );
        rawText = Buffer.from(fetched.body).toString('utf8');
      }
    }
    if (Buffer.byteLength(rawText, 'utf8') > MAX_RAW_TEXT_BYTES) {
      throw apiError(501065, requestId, {
        limitBytes: MAX_RAW_TEXT_BYTES,
        actualBytes: Buffer.byteLength(rawText, 'utf8'),
      });
    }
    if (rawText.length === 0 && !body.fileRef) {
      throw apiError(501056, requestId, { format: 'unknown' });
    }
    const chunkSize = body.chunkPolicy?.chunkSize ?? 512;
    const chunks: Array<{ index: number; text: string; length: number }> = [];
    for (let offset = 0, index = 0; offset < rawText.length; offset += chunkSize, index += 1) {
      const text = rawText.slice(offset, offset + chunkSize);
      chunks.push({ index, text, length: text.length });
      if (index >= 99) break;
    }
    response.status(200).json(successResponse({ chunks }, requestId));
  },
  { validationErrorCode: 501056 },
);
