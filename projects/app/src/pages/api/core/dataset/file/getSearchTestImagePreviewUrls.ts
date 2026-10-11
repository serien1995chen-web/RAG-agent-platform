import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { apiError } from '../../../../../shared/import-source';
import { objectStoreOf } from '../../../../../shared/object-store';

interface PreviewUrlsBody {
  keys: string[];
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
    const store = objectStoreOf(runtime);
    if (!store) throw apiError(501011, requestId, { reason: 'store_unavailable' });
    const previewUrls: string[] = [];
    for (const key of body.keys) {
      previewUrls.push(
        await store.presignGet({ ref: { bucket: 'kb-image', key }, expiresSeconds: 3600 }, context),
      );
    }
    response.status(200).json(successResponse({ previewUrls }, requestId));
  },
  { validationErrorCode: 501011 },
);