import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { apiError } from '../../../../../shared/import-source';
import { objectStoreOf } from '../../../../../shared/object-store';
import {
  findPartByChecksum,
  getSessionByUploadId,
  recordPart,
} from '../../../../../shared/file-session';

interface UploadPartForm {
  uploadId: string;
  partNumber: number;
  checksum?: string;
  chunk?: { size?: number; data?: string } | string;
}

function chunkBytes(chunk: UploadPartForm['chunk']): Uint8Array {
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (chunk && typeof chunk.data === 'string') return Buffer.from(chunk.data, 'base64');
  return new Uint8Array();
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
    const session = getSessionByUploadId(body.uploadId, context.tenant.teamId);
    if (!session) throw apiError(501061, requestId, {});
    const bytes = chunkBytes(body.chunk);
    if (bytes.byteLength === 0) throw apiError(501060, requestId, { reason: 'empty_part' });
    if (body.checksum !== undefined) {
      const existing = findPartByChecksum(session.fileId, body.partNumber, body.checksum);
      if (existing !== null) {
        response.status(200).json(
          successResponse({ etag: existing, partNumber: body.partNumber, size: bytes.byteLength }, requestId),
        );
        return;
      }
    }
    const store = objectStoreOf(runtime);
    if (!store) throw apiError(501060, requestId, { reason: 'store_unavailable' });
    try {
      const result = await store.uploadPart(
        {
          ref: {
            bucket: session.bucket,
            key: session.key,
            ...(session.uploadId ? { multipartUploadId: session.uploadId } : {}),
          },
          partNumber: body.partNumber,
          body: bytes,
          ...(body.checksum !== undefined ? { checksum: body.checksum } : {}),
        },
        context,
      );
      recordPart(
        session.fileId,
        body.partNumber,
        { etag: result.etag, size: result.size },
        body.checksum,
      );
      response
        .status(200)
        .json(
          successResponse(
            { etag: result.etag, partNumber: result.partNumber, size: result.size },
            requestId,
          ),
        );
    } catch {
      throw apiError(501060, requestId, { reason: 'part_failed' });
    }
  },
  { validationErrorCode: 501060 },
);
