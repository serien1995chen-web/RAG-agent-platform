import { randomUUID } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime, type ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface PresignSearchTestImageBody {
  filename: string;
  size: number;
  mime: string;
}

interface RedisJsonStore {
  set(key: string, value: string, mode?: string, ttlSeconds?: number): Promise<unknown>;
}

interface PresignStore {
  presignPut(
    input: {
      ref: { bucket: string; key: string };
      expiresSeconds: number;
    },
    context: { teamId: string },
  ): Promise<string>;
}

const IMAGE_TTL_SECONDS = 2 * 60 * 60;

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

/** API-FILE-005 POST /api/core/dataset/file/presignSearchTestImage */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<PresignSearchTestImageBody>('PresignSearchTestImageBody', request.body);
    const maxBytes = runtime.config.datasetRuntime.maxRequestBodyBytes;
    if (body.size > maxBytes) {
      throw apiError(501065, requestId, { limitBytes: maxBytes, actualBytes: body.size });
    }
    const store = runtime.clients.objectStore as unknown as PresignStore;
    const key = `temp/${context.tenant.teamId}/${randomUUID()}`;
    const url = await store.presignPut(
      { ref: { bucket: runtime.config.system.s3.bucket, key }, expiresSeconds: IMAGE_TTL_SECONDS },
      { teamId: context.tenant.teamId },
    );
    const expiresAt = new Date(Date.now() + IMAGE_TTL_SECONDS * 1000).toISOString();
    const redis = runtime.clients.redis as unknown as RedisJsonStore;
    await redis.set(tempKeyRecord(context.tenant.teamId, key), expiresAt, 'EX', IMAGE_TTL_SECONDS);
    response.status(200).json(successResponse({ url, key, expiresAt }, requestId));
  },
  { validationErrorCode: 501065 },
);
