import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { MAX_RAW_TEXT_BYTES, apiError } from '../../../../../shared/import-source';
import { objectStoreOf } from '../../../../../shared/object-store';

interface ChunkPolicyValue {
  mode?: 'auto' | 'paragraph' | 'custom';
  chunkSize?: number;
  minSize?: number;
  maxSize?: number;
  overlapRatio?: number;
  paragraphDeep?: number;
  customRegs?: string[];
  lengthUnit?: 'char' | 'token';
  forceSplit?: boolean;
  maxChunks?: number;
}

interface PreviewChunksBody {
  fileRef: string;
  chunkPolicy: ChunkPolicyValue;
}

function splitByPolicy(
  text: string,
  policy: ChunkPolicyValue,
): Array<{ index: number; text: string; length: number }> {
  const chunkSize = policy.chunkSize ?? 1000;
  const minSize = policy.minSize ?? 100;
  const maxSize = policy.maxSize ?? 8000;
  const overlapRatio = policy.overlapRatio ?? 0.15;
  const maxChunks = policy.maxChunks ?? 50000;
  const size = Math.max(1, Math.min(maxSize, Math.max(minSize, chunkSize)));
  const overlap = Math.max(0, Math.min(size - 1, Math.floor(size * overlapRatio)));
  const step = Math.max(1, size - overlap);
  const chunks: Array<{ index: number; text: string; length: number }> = [];
  for (let offset = 0, index = 0; offset < text.length; offset += step, index += 1) {
    const value = text.slice(offset, offset + size);
    chunks.push({ index, text: value, length: value.length });
    if (chunks.length >= maxChunks) break;
  }
  return chunks;
}

/** API-FILE-004 POST /api/core/dataset/file/previewChunks */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<PreviewChunksBody>('PreviewChunksBody', request.body);
    let rawText = '';
    const store = objectStoreOf(runtime);
    if (store) {
      const fetched = await store.get({ ref: { bucket: 'kb-source', key: body.fileRef } }, context);
      rawText = Buffer.from(fetched.body).toString('utf8');
    }
    const actualBytes = Buffer.byteLength(rawText, 'utf8');
    if (actualBytes > MAX_RAW_TEXT_BYTES) {
      throw apiError(501065, requestId, { limitBytes: MAX_RAW_TEXT_BYTES, actualBytes });
    }
    if (rawText.length === 0) {
      throw apiError(501056, requestId, { format: body.fileRef.split('.').pop() ?? 'unknown' });
    }
    const chunks = splitByPolicy(rawText, body.chunkPolicy);
    response.status(200).json(successResponse({ chunks }, requestId));
  },
  { validationErrorCode: 501056 },
);
