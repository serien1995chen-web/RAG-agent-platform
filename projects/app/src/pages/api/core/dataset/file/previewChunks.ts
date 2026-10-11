import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

const MAX_RAW_TEXT_BYTES = 10 * 1024 * 1024;

interface ChunkPolicyValue {
  chunkSize?: number;
  minSize?: number;
  maxSize?: number;
  overlapRatio?: number;
  maxChunks?: number;
}

interface PreviewChunksBody {
  fileRef: string;
  chunkPolicy: ChunkPolicyValue;
}

function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

function objectStoreOf(runtime: unknown) {
  const store = (runtime as { clients?: { objectStore?: { get?: unknown } } }).clients?.objectStore;
  return store && typeof store.get === 'function' ? store : null;
}

function splitByPolicy(text: string, policy: ChunkPolicyValue) {
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
    const store = objectStoreOf(runtime);
    if (!store) throw apiError(501056, requestId, { format: 'store_unavailable' });
    const fetched = await (
      store as { get: (i: unknown, c: unknown) => Promise<{ body: Uint8Array }> }
    ).get({ ref: { bucket: 'kb-source', key: body.fileRef } }, { teamId: context.tenant.teamId });
    const rawText = Buffer.from(fetched.body).toString('utf8');
    const actualBytes = Buffer.byteLength(rawText, 'utf8');
    if (actualBytes > MAX_RAW_TEXT_BYTES) {
      throw apiError(501065, requestId, { limitBytes: MAX_RAW_TEXT_BYTES, actualBytes });
    }
    if (rawText.length === 0) {
      throw apiError(501056, requestId, { format: body.fileRef.split('.').pop() ?? 'unknown' });
    }
    response
      .status(200)
      .json(successResponse({ chunks: splitByPolicy(rawText, body.chunkPolicy) }, requestId));
  },
  { validationErrorCode: 501056 },
);
