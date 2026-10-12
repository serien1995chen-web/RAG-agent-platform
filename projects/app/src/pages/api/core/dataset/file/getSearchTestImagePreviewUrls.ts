import { ApiErrorException, createApiError } from '@kb/contracts';
import { objectKeyHash } from '@kb/storage';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { createRuntimeObjectStorePort } from '../../../../../runtime/object-store-adapter';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface PreviewUrlsBody {
  keys: string[];
}

function scopeForbidden(requestId: string, key: string, datasetId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501061,
      requestId,
      params: { fileId: objectKeyHash(key), datasetId },
    }),
  );
}

/** API-FILE-006 POST /api/core/dataset/file/getSearchTestImagePreviewUrls */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<PreviewUrlsBody>('PreviewUrlsBody', request.body);
    const objectStore = createRuntimeObjectStorePort(runtime.clients.objectStore);
    const bucket = runtime.config.system.s3.bucket;
    const previewUrls: string[] = [];
    for (const key of body.keys) {
      const [prefix, teamId, expiresRaw] = key.split('/');
      if (prefix !== 'temp' || teamId !== context.tenant.teamId) {
        throw scopeForbidden(requestId, key, '');
      }
      const expiresAt = Number(expiresRaw);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw new ApiErrorException(
          createApiError({
            code: 501011,
            requestId,
            params: {
              keyHash: objectKeyHash(key),
              expiredAt: new Date(expiresAt || 0).toISOString(),
            },
          }),
        );
      }
      const object = await objectStore.get(
        { ref: { bucket, key }, options: { timeoutMs: 15_000 } },
        context,
      );
      previewUrls.push(`data:image/png;base64,${Buffer.from(object.body).toString('base64')}`);
    }
    response.status(200).json(successResponse({ previewUrls }, requestId));
  },
  { validationErrorCode: 501061 },
);
