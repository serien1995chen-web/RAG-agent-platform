import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

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
    const sessions = runtime.fileUploadService;
    const session = sessions.getSession(body.fileId, context.tenant.teamId);
    if (!session) throw apiError(501061, requestId, {});
    await runtime.clients.objectStore.abort(
      { ref: { bucket: session.bucket, key: session.key } },
      { teamId: context.tenant.teamId, datasetId: session.datasetId },
    );
    sessions.deleteSession(body.fileId);
    response.status(200).json(successResponse({ aborted: true }, requestId));
  },
  { validationErrorCode: 501070 },
);
