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
}

function sessionState(): SessionState {
  const g = globalThis as unknown as { __p4FileSessions?: SessionState };
  g.__p4FileSessions ??= { sessions: new Map(), parts: new Map() };
  return g.__p4FileSessions;
}

interface AbortMultipartBody {
  fileId: string;
  uploadId: string;
}

function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

/** API-FILE-003 POST /api/core/dataset/file/abortMultipart */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<AbortMultipartBody>('AbortMultipartBody', request.body);
    const state = sessionState();
    const session = state.sessions.get(body.fileId);
    if (!session || session.teamId !== context.tenant.teamId) {
      throw apiError(501061, requestId, {});
    }
    const store = (runtime.clients as { objectStore?: { abort?: unknown } }).objectStore;
    if (!store || typeof store.abort !== 'function') {
      throw apiError(501017, requestId, { provider: 's3' });
    }
    await (store as { abort: (i: unknown, c: unknown) => Promise<unknown> }).abort(
      { ref: { bucket: session.bucket, key: session.key } },
      { teamId: context.tenant.teamId, datasetId: session.datasetId },
    );
    state.sessions.delete(body.fileId);
    state.parts.delete(body.fileId);
    response.status(200).json(successResponse({ aborted: true }, requestId));
  },
  { validationErrorCode: 501070 },
);
