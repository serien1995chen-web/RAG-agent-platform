import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { apiError } from '../../../../../shared/import-source';
import { objectStoreOf } from '../../../../../shared/object-store';
import { deleteSession, getSession } from '../../../../../shared/file-session';

interface AbortMultipartBody {
  fileId: string;
  uploadId?: string;
}

/** API-FILE-003 POST /api/core/dataset/file/abortMultipart */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<AbortMultipartBody>('AbortMultipartBody', request.body);
    const session = getSession(body.fileId, context.tenant.teamId);
    if (!session) throw apiError(501061, requestId, {});
    const store = objectStoreOf(runtime);
    if (!store) throw apiError(501017, requestId, { provider: 's3' });
    await store.abort({ ref: { bucket: session.bucket, key: session.key } }, context);
    deleteSession(body.fileId);
    response.status(200).json(successResponse({ aborted: true }, requestId));
  },
  { validationErrorCode: 501070 },
);