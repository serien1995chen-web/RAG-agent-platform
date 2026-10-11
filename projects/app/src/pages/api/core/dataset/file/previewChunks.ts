import { chunkText, type ChunkPolicy } from '../../../../../../../../packages/chunk/src/index';
import { ApiErrorException, createApiError } from '@kb/contracts';
import { createDefaultDocumentParser } from '../../../../../../../../packages/parse/src/index';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime, type ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface PreviewChunksBody {
  fileRef: string;
  chunkPolicy: ChunkPolicy;
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
    const parts = body.fileRef.split('/');
    const datasetId = parts[0] === 'dataset' ? (parts[1] ?? '') : '';
    if (!datasetId) throw apiError(501017, requestId, { resource: 'fileRef' });
    await runtime.datasetApi.getDatasetDetail(datasetId, context);

    const stored = await runtime.clients.objectStore.get(
      { ref: { bucket: runtime.config.system.s3.bucket, key: body.fileRef } },
      { teamId: context.tenant.teamId, datasetId },
    );
    const maxBytes = runtime.config.datasetRuntime.maxRawTextBytes;
    if (stored.body.byteLength > maxBytes) {
      throw apiError(501065, requestId, {
        limitBytes: maxBytes,
        actualBytes: stored.body.byteLength,
      });
    }

    const parser = createDefaultDocumentParser();
    const parsed = await parser.parse({
      teamId: context.tenant.teamId,
      datasetId,
      fileRef: body.fileRef,
      extension: extensionOf(body.fileRef),
      timeoutMs: 10_000,
      bytes: stored.body,
    } as never);
    const chunks = chunkText({ text: parsed.rawText, policy: body.chunkPolicy }).chunks;
    response.status(200).json(successResponse({ chunks }, requestId));
  },
  { validationErrorCode: 501056 },
);
