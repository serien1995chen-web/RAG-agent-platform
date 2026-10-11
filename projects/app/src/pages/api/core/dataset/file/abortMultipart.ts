import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime, type ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface AbortMultipartBody {
  fileId: string;
  uploadId: string;
}

interface MultipartSession {
  fileId: string;
  teamId: string;
  datasetId: string;
  bucket: string;
  key: string;
  uploadId: string;
}

interface RedisJsonStore {
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
}

interface MultipartStore {
  abort(
    input: { ref: { bucket: string; key: string } },
    context: { teamId: string; datasetId: string },
  ): Promise<{ aborted: boolean }>;
}

function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

function sessionKey(teamId: string, fileId: string): string {
  return `p4:multipart:${teamId}:${fileId}`;
}

function uploadIndexKey(teamId: string, uploadId: string): string {
  return `p4:multipart-upload:${teamId}:${uploadId}`;
}

function ownerKey(fileId: string): string {
  return `p4:multipart-owner:${fileId}`;
}

/** API-FILE-003 POST /api/core/dataset/file/abortMultipart */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<AbortMultipartBody>('AbortMultipartBody', request.body);
    const redis = runtime.clients.redis as unknown as RedisJsonStore;
    const owner = await redis.get(ownerKey(body.fileId));
    if (owner !== null && owner !== context.tenant.teamId) {
      throw apiError(501061, requestId, {});
    }

    const raw = await redis.get(sessionKey(context.tenant.teamId, body.fileId));
    if (!raw) {
      response.status(200).json(successResponse({ aborted: true }, requestId));
      return;
    }
    const session = JSON.parse(raw) as MultipartSession;
    if (session.uploadId !== body.uploadId && session.fileId !== body.uploadId) {
      throw apiError(501061, requestId, {});
    }

    const store = runtime.clients.objectStore as unknown as MultipartStore;
    await store.abort(
      { ref: { bucket: session.bucket, key: session.key } },
      { teamId: context.tenant.teamId, datasetId: session.datasetId },
    );
    await redis.del(
      sessionKey(context.tenant.teamId, session.fileId),
      uploadIndexKey(context.tenant.teamId, session.uploadId),
      ownerKey(session.fileId),
    );
    response.status(200).json(successResponse({ aborted: true }, requestId));
  },
  { validationErrorCode: 501070 },
);
