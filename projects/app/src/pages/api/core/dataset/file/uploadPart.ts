import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface MultipartSession {
  fileId: string;
  teamId: string;
  datasetId: string;
  key: string;
  uploadId: string;
  bucket: string;
}

interface SessionState {
  sessions: Map<string, MultipartSession>;
  parts: Map<string, Map<number, { etag: string; size: number }>>;
  checksums: Map<string, string>;
}

function sessionState(): SessionState {
  const g = globalThis as unknown as { __p4FileSessions?: SessionState };
  g.__p4FileSessions ??= { sessions: new Map(), parts: new Map(), checksums: new Map() };
  g.__p4FileSessions.checksums ??= new Map();
  return g.__p4FileSessions;
}

interface UploadPartForm {
  uploadId: string;
  partNumber: number;
  checksum: string;
  chunk: string;
}

function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
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
    const state = sessionState();
    const session = [...state.sessions.values()].find(
      (value) => value.uploadId === body.uploadId && value.teamId === context.tenant.teamId,
    );
    if (!session) throw apiError(501061, requestId, {});
    const bytes = Buffer.from(body.chunk, 'base64');
    if (bytes.byteLength === 0) throw apiError(501060, requestId, { reason: 'empty_part' });
    const checksumKey = `${body.uploadId}:${body.partNumber}:${body.checksum}`;
    const existing = state.checksums.get(checksumKey);
    if (existing) {
      response
        .status(200)
        .json(
          successResponse(
            { etag: existing, partNumber: body.partNumber, size: bytes.byteLength },
            requestId,
          ),
        );
      return;
    }
    const store = (runtime.clients as { objectStore?: { uploadPart?: unknown } }).objectStore;
    if (!store || typeof store.uploadPart !== 'function') {
      throw apiError(501060, requestId, { reason: 'store_unavailable' });
    }
    const result = await (
      store as {
        uploadPart: (
          i: unknown,
          c: unknown,
        ) => Promise<{ etag: string; partNumber: number; size: number }>;
      }
    ).uploadPart(
      {
        ref: { bucket: session.bucket, key: session.key, multipartUploadId: session.uploadId },
        partNumber: body.partNumber,
        body: bytes,
        checksum: body.checksum,
      },
      { teamId: context.tenant.teamId, datasetId: session.datasetId },
    );
    const bucket = state.parts.get(session.fileId) ?? new Map();
    bucket.set(body.partNumber, { etag: result.etag, size: result.size });
    state.parts.set(session.fileId, bucket);
    state.checksums.set(checksumKey, result.etag);
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
