import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

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
    const sessions = runtime.fileUploadService;
    // presign 返回的 fileId 即客户端上传时使用的 uploadId；按 fileId 解析 session（Rev2 §7 P4-07）。
    const session =
      sessions.getSession(body.uploadId, context.tenant.teamId) ??
      sessions.getSessionByUploadId(body.uploadId, context.tenant.teamId);
    if (!session) throw apiError(501061, requestId, {});
    const bytes = Buffer.from(body.chunk, 'base64');
    if (bytes.byteLength === 0) throw apiError(501060, requestId, { reason: 'empty_part' });
    const existing = sessions.findPartByChecksum(session.fileId, body.partNumber, body.checksum);
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
    const objectContext = { teamId: context.tenant.teamId, datasetId: session.datasetId };
    const result = await runtime.clients.objectStore.uploadPart(
      {
        ref: { bucket: session.bucket, key: session.key, multipartUploadId: session.uploadId },
        partNumber: body.partNumber,
        body: bytes,
        checksum: body.checksum,
      },
      objectContext,
    );
    sessions.recordPart(session.fileId, {
      partNumber: result.partNumber,
      etag: result.etag,
      size: result.size,
      checksum: body.checksum,
    });
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
