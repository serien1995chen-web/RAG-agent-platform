import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime, type ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface PreviewUrlsBody {
  keys: string[];
}

interface RedisJsonStore {
  get(key: string): Promise<string | null>;
}

interface PresignStore {
  presignGet(
    input: {
      ref: { bucket: string; key: string };
      expiresSeconds: number;
    },
    context: { teamId: string },
  ): Promise<string>;
}

function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

function tempKeyRecord(teamId: string, key: string): string {
  return `p4:temp-key:${teamId}:${Buffer.from(key).toString('base64url')}`;
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
    const redis = runtime.clients.redis as unknown as RedisJsonStore;
    const store = runtime.clients.objectStore as unknown as PresignStore;
    const previewUrls: string[] = [];
    for (const key of body.keys) {
      if (!key.startsWith(prefix)) throw apiError(501061, requestId, {});
      const expiresAt = await redis.get(tempKeyRecord(context.tenant.teamId, key));
      if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) {
        throw apiError(501011, requestId, { reason: 'expired_temp_key' });
      }
      previewUrls.push(
        await store.presignGet(
          { ref: { bucket: runtime.config.system.s3.bucket, key }, expiresSeconds: 3600 },
          { teamId: context.tenant.teamId },
        ),
      );
    }
    response.status(200).json(successResponse({ previewUrls }, requestId));
  },
  { validationErrorCode: 501011 },
);
