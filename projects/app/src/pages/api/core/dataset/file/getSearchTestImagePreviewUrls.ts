import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface PreviewUrlsBody {
  keys: string[];
}

function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

/** API-FILE-006 POST /api/core/dataset/file/getSearchTestImagePreviewUrls */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<PreviewUrlsBody>('PreviewUrlsBody', request.body);
    if (body.keys.length === 0 || body.keys.length > 10) {
      throw apiError(501065, requestId, { limit: 10, actual: body.keys.length });
    }
    const prefix = `temp/${context.tenant.teamId}/`;
    for (const key of body.keys) {
      if (!key.startsWith(prefix)) throw apiError(501061, requestId, {});
    }
    const store = (runtime.clients as { objectStore?: { presignGet?: unknown } }).objectStore;
    if (!store || typeof store.presignGet !== 'function') {
      throw apiError(501011, requestId, { reason: 'store_unavailable' });
    }
    const previewUrls: string[] = [];
    for (const key of body.keys) {
      previewUrls.push(
        await (store as { presignGet: (i: unknown, c: unknown) => Promise<string> }).presignGet(
          { ref: { bucket: 'kb-image', key }, expiresSeconds: 3600 },
          { teamId: context.tenant.teamId },
        ),
      );
    }
    response.status(200).json(successResponse({ previewUrls }, requestId));
  },
  { validationErrorCode: 501011 },
);
