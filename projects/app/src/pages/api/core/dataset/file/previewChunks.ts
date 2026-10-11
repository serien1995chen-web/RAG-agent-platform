import { ApiErrorException, createApiError } from '@kb/contracts';
import { parseAndChunkPreview } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

const MAX_RAW_TEXT_BYTES = 10 * 1024 * 1024;

interface PreviewChunksBody {
  fileRef: string;
  chunkPolicy: Record<string, unknown>;
}

function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

function extensionOf(fileRef: string): string {
  const clean = fileRef.split('?')[0] ?? fileRef;
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : 'txt';
}

/** API-FILE-004 POST /api/core/dataset/file/previewChunks */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<PreviewChunksBody>('PreviewChunksBody', request.body);
    // fileRef 形如 dataset/{datasetId}/{fileId}[.ext]；据此解析 dataset scope。
    const parts = body.fileRef.split('/');
    const datasetId = parts[0] === 'dataset' ? (parts[1] ?? '') : '';
    if (datasetId) {
      // 先校验 Dataset 属于认证团队，再取对象。
      await runtime.datasetApi.getDatasetDetail(datasetId, context);
    }
    const stored = await runtime.clients.objectStore.get(
      { ref: { bucket: 'kb-source', key: body.fileRef } },
      { teamId: context.tenant.teamId, ...(datasetId ? { datasetId } : {}) },
    );
    const bytes = stored.body;
    if (bytes.byteLength > MAX_RAW_TEXT_BYTES) {
      throw apiError(501065, requestId, {
        limitBytes: MAX_RAW_TEXT_BYTES,
        actualBytes: bytes.byteLength,
      });
    }
    // 真实 Parser + Chunk：@kb/parse 解析字节，@kb/chunk 按 ChunkPolicy 确定性切分。
    const { chunks } = await parseAndChunkPreview({
      bytes,
      extension: extensionOf(body.fileRef),
      teamId: context.tenant.teamId,
      datasetId: datasetId || context.tenant.teamId,
      fileRef: body.fileRef,
      timeoutMs: 10_000,
      policy: body.chunkPolicy,
    });
    response.status(200).json(successResponse({ chunks }, requestId));
  },
  { validationErrorCode: 501056 },
);
