import { randomUUID } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime, type ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface PresignUploadBody {
  datasetId: string;
  filename: string;
  size: number;
  mime: string;
}

interface RedisJsonStore {
  set(key: string, value: string, mode?: string, ttlSeconds?: number): Promise<unknown>;
}

interface MultipartStore {
  prepareMultipart(
    input: { ref: { bucket: string; key: string }; parts: number },
    context: { teamId: string; datasetId: string },
  ): Promise<{ multipartUploadId?: string }>;
}

const SESSION_TTL_SECONDS = 15 * 60;

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

/** API-FILE-001 POST /api/core/dataset/file/presignUpload */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<PresignUploadBody>('PresignUploadBody', request.body);
    const maxBytes = runtime.config.datasetRuntime.maxRequestBodyBytes;
    if (body.size > maxBytes) {
      throw apiError(501065, requestId, { limitBytes: maxBytes, actualBytes: body.size });
    }
    await runtime.datasetApi.getDatasetDetail(body.datasetId, context);

    const store = runtime.clients.objectStore as unknown as MultipartStore;
    const bucket = runtime.config.system.s3.bucket;
    const fileId = randomUUID();
    const key = `dataset/${body.datasetId}/${fileId}`;
    const objectContext = { teamId: context.tenant.teamId, datasetId: body.datasetId };
    const prepared = await store.prepareMultipart(
      { ref: { bucket, key }, parts: 1 },
      objectContext,
    );
    const uploadId = prepared.multipartUploadId ?? fileId;
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
    const session = {
      fileId,
      teamId: context.tenant.teamId,
      datasetId: body.datasetId,
      bucket,
      key,
      uploadId,
      expectedSize: body.size,
      expiresAt,
      parts: [],
    };
    const redis = runtime.clients.redis as unknown as RedisJsonStore;
    await redis.set(
      sessionKey(context.tenant.teamId, fileId),
      JSON.stringify(session),
      'EX',
      SESSION_TTL_SECONDS,
    );
    await redis.set(
      uploadIndexKey(context.tenant.teamId, uploadId),
      fileId,
      'EX',
      SESSION_TTL_SECONDS,
    );
    await redis.set(ownerKey(fileId), context.tenant.teamId, 'EX', SESSION_TTL_SECONDS);

    response.status(200).json(
      successResponse(
        {
          uploadUrl: `/api/core/dataset/file/uploadPart?fileId=${fileId}`,
          fileId,
          expiresAt,
        },
        requestId,
      ),
    );
  },
  { validationErrorCode: 501065 },
);
