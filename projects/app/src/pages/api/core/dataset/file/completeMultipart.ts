import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { apiError } from '../../../../../shared/import-source';
import { objectStoreOf } from '../../../../../shared/object-store';
import { getSession, listParts, totalSize } from '../../../../../shared/file-session';

interface CompleteMultipartBody {
  fileId: string;
  parts?: Array<{ partNumber: number; etag: string }>;
  hash?: string;
}

/** API-FILE-002 POST /api/core/dataset/file/completeMultipart */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CompleteMultipartBody>('CompleteMultipartBody', request.body);
    if (body.parts !== undefined && body.parts.length > 10000) {
      throw apiError(501060, requestId, { reason: 'too_many_parts' });
    }
    const session = getSession(body.fileId, context.tenant.teamId);
    if (!session) throw apiError(501061, requestId, {});
    const store = objectStoreOf(runtime);
    if (!store) throw apiError(501060, requestId, { reason: 'store_unavailable' });
    const parts = body.parts ?? listParts(body.fileId);
    if (parts.length === 0) throw apiError(501060, requestId, { reason: 'no_parts' });
    if (totalSize(body.fileId) <= 0) throw apiError(501060, requestId, { reason: 'empty_payload' });
    const completed = await store.completeMultipart(
      {
        ref: {
          bucket: session.bucket,
          key: session.key,
          ...(session.uploadId ? { multipartUploadId: session.uploadId } : {}),
        },
        parts,
      },
      context,
    );
    response
      .status(200)
      .json(successResponse({ fileRef: `file:${body.fileId}:${completed.etag ?? ''}` }, requestId));
  },
  { validationErrorCode: 501060 },
);
