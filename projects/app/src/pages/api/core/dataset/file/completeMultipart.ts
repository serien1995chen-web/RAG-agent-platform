import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

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
    if (typeof body.hash !== 'string' || body.hash.length === 0) {
      throw apiError(501060, requestId, { reason: 'missing_hash' });
    }
    const sessions = runtime.fileUploadService;
    // 先校验归属、分片集合/顺序/ETag/累计大小，任一不符 501060。
    const session = sessions.validateComplete(
      body.fileId,
      context.tenant.teamId,
      body.parts,
      requestId,
    );
    const objectContext = { teamId: context.tenant.teamId, datasetId: session.datasetId };
    const completed = await runtime.clients.objectStore.completeMultipart(
      {
        ref: { bucket: session.bucket, key: session.key, multipartUploadId: session.uploadId },
        parts: body.parts,
      },
      objectContext,
    );
    sessions.deleteSession(body.fileId);
    response
      .status(200)
      .json(successResponse({ fileRef: `file:${body.fileId}:${completed.etag ?? ''}` }, requestId));
  },
  { validationErrorCode: 501060 },
);
