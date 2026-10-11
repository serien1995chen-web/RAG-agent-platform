import { createHash } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime, type ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface CompleteMultipartBody {
  fileId: string;
  parts: Array<{ partNumber: number; etag: string }>;
  hash: string;
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
  del(...keys: string[]): Promise<unknown>;
}

interface MultipartStore {
  completeMultipart(
    input: {
      ref: { bucket: string; key: string; multipartUploadId: string };
      parts: Array<{ partNumber: number; etag: string }>;
    },
    context: { teamId: string; datasetId: string },
  ): Promise<{ etag?: string }>;
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

function expectedHash(parts: MultipartPart[]): string {
  const material = parts.map((part) => `${part.partNumber}:${part.etag}:${part.checksum}`).join('');
  return createHash('sha256').update(material).digest('hex');
}

async function readSession(
  redis: RedisJsonStore,
  teamId: string,
  fileId: string,
): Promise<MultipartSession | null> {
  const raw = await redis.get(sessionKey(teamId, fileId));
  if (!raw) return null;
  const session = JSON.parse(raw) as MultipartSession;
  if (Date.parse(session.expiresAt) <= Date.now()) return null;
  return session;
}

/** API-FILE-002 POST /api/core/dataset/file/completeMultipart */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CompleteMultipartBody>('CompleteMultipartBody', request.body);
    if (body.parts.length === 0 || body.parts.length > 10000 || body.hash.length === 0) {
      throw apiError(501060, requestId, { reason: 'invalid_complete_request' });
    }

    const redis = runtime.clients.redis as unknown as RedisJsonStore;
    const session = await readSession(redis, context.tenant.teamId, body.fileId);
    if (!session) throw apiError(501060, requestId, { reason: 'unknown_session' });

    const uploaded = session.parts;
    const requested = [...body.parts].sort((left, right) => left.partNumber - right.partNumber);
    if (
      uploaded.length !== requested.length ||
      uploaded.some(
        (part, index) =>
          part.partNumber !== requested[index]?.partNumber || part.etag !== requested[index]?.etag,
      )
    ) {
      throw apiError(501060, requestId, { reason: 'part_mismatch' });
    }
    const totalSize = uploaded.reduce((sum, part) => sum + part.size, 0);
    if (totalSize !== session.expectedSize) {
      throw apiError(501060, requestId, {
        reason: 'size_mismatch',
        expectedBytes: session.expectedSize,
        actualBytes: totalSize,
      });
    }
    if (expectedHash(uploaded) !== body.hash) {
      throw apiError(501060, requestId, { reason: 'hash_mismatch' });
    }

    const store = runtime.clients.objectStore as unknown as MultipartStore;
    const completed = await store.completeMultipart(
      {
        ref: { bucket: session.bucket, key: session.key, multipartUploadId: session.uploadId },
        parts: requested,
      },
      { teamId: context.tenant.teamId, datasetId: session.datasetId },
    );
    await redis.del(
      sessionKey(context.tenant.teamId, session.fileId),
      uploadIndexKey(context.tenant.teamId, session.uploadId),
      ownerKey(session.fileId),
    );

    response
      .status(200)
      .json(successResponse({ fileRef: `file:${body.fileId}:${completed.etag ?? ''}` }, requestId));
  },
  { validationErrorCode: 501060 },
);
