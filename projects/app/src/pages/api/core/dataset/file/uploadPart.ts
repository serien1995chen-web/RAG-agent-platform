import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime, type ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface UploadPartForm {
  uploadId: string;
  partNumber: number;
  checksum: string;
  chunk: string | Uint8Array;
}

interface MultipartPart {
  partNumber: number;
  etag: string;
  size: number;
  checksum: string;
}

interface MultipartSession {
  fileId: string;
  teamId: string;
  datasetId: string;
  bucket: string;
  key: string;
  uploadId: string;
  expectedSize: number;
  expiresAt: string;
  parts: MultipartPart[];
}

interface RedisJsonStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttlSeconds?: number): Promise<unknown>;
}

interface MultipartStore {
  uploadPart(
    input: {
      ref: { bucket: string; key: string; multipartUploadId: string };
      partNumber: number;
      body: Uint8Array;
      checksum: string;
    },
    context: { teamId: string; datasetId: string },
  ): Promise<{ etag: string; partNumber: number; size: number }>;
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

async function readSession(
  redis: RedisJsonStore,
  teamId: string,
  uploadId: string,
): Promise<MultipartSession | null> {
  const indexed = await redis.get(uploadIndexKey(teamId, uploadId));
  const fileId = indexed ?? uploadId;
  const raw = await redis.get(sessionKey(teamId, fileId));
  if (!raw) return null;
  const session = JSON.parse(raw) as MultipartSession;
  if (Date.parse(session.expiresAt) <= Date.now()) return null;
  return session;
}

function chunkBytes(chunk: string | Uint8Array): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  return Buffer.from(chunk, 'base64');
}

/** API-FILE-007 POST /api/core/dataset/file/uploadPart */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<UploadPartForm>('UploadPartForm', request.body);
    if (body.partNumber < 1 || body.partNumber > 10000) {
      throw apiError(501065, requestId, { partNumber: body.partNumber });
    }

    const redis = runtime.clients.redis as unknown as RedisJsonStore;
    const session = await readSession(redis, context.tenant.teamId, body.uploadId);
    if (!session) throw apiError(501061, requestId, {});

    const bytes = chunkBytes(body.chunk);
    if (bytes.byteLength === 0) throw apiError(501060, requestId, { reason: 'empty_part' });
    const existing = session.parts.find((part) => part.partNumber === body.partNumber);
    if (existing) {
      if (existing.checksum !== body.checksum) {
        throw apiError(501060, requestId, { reason: 'checksum_conflict' });
      }
      response
        .status(200)
        .json(
          successResponse(
            { etag: existing.etag, partNumber: existing.partNumber, size: existing.size },
            requestId,
          ),
        );
      return;
    }

    const store = runtime.clients.objectStore as unknown as MultipartStore;
    const result = await store.uploadPart(
      {
        ref: { bucket: session.bucket, key: session.key, multipartUploadId: session.uploadId },
        partNumber: body.partNumber,
        body: bytes,
        checksum: body.checksum,
      },
      { teamId: context.tenant.teamId, datasetId: session.datasetId },
    );
    session.parts.push({
      partNumber: result.partNumber,
      etag: result.etag,
      size: result.size,
      checksum: body.checksum,
    });
    session.parts.sort((left, right) => left.partNumber - right.partNumber);
    await redis.set(
      sessionKey(context.tenant.teamId, session.fileId),
      JSON.stringify(session),
      'EX',
      SESSION_TTL_SECONDS,
    );

    response
      .status(200)
      .json(
        successResponse(
          { etag: result.etag, partNumber: result.partNumber, size: result.size },
          requestId,
        ),
      );
  },
  { validationErrorCode: 501060 },
);
