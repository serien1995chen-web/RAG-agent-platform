import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
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
}

function sessionState(): SessionState {
  const g = globalThis as unknown as { __p4FileSessions?: SessionState };
  g.__p4FileSessions ??= { sessions: new Map(), parts: new Map() };
  return g.__p4FileSessions;
}

interface CompleteMultipartBody {
  fileId: string;
  parts: Array<{ partNumber: number; etag: string }>;
  hash: string;
}

function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

/** API-FILE-002 POST /api/core/dataset/file/completeMultipart */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CompleteMultipartBody>('CompleteMultipartBody', request.body);
    if (body.parts.length > 10000) {
      throw apiError(501060, requestId, { reason: 'too_many_parts' });
    }
    const state = sessionState();
    const session = state.sessions.get(body.fileId);
    if (!session || session.teamId !== context.tenant.teamId) {
      throw apiError(501061, requestId, {});
    }
    const recorded = state.parts.get(body.fileId);
    if (!recorded || recorded.size === 0) {
      throw apiError(501060, requestId, { reason: 'no_parts' });
    }
    const store = (runtime.clients as { objectStore?: { completeMultipart?: unknown } })
      .objectStore;
    if (!store || typeof store.completeMultipart !== 'function') {
      throw apiError(501060, requestId, { reason: 'store_unavailable' });
    }
    const completed = await (
      store as { completeMultipart: (i: unknown, c: unknown) => Promise<{ etag?: string }> }
    ).completeMultipart(
      {
        ref: { bucket: session.bucket, key: session.key, multipartUploadId: session.uploadId },
        parts: body.parts,
      },
      { teamId: context.tenant.teamId, datasetId: session.datasetId },
    );
    response
      .status(200)
      .json(successResponse({ fileRef: `file:${body.fileId}:${completed.etag ?? ''}` }, requestId));
  },
  { validationErrorCode: 501060 },
);
