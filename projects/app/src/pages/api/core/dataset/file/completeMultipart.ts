import type { MultipartPartReceipt } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { createRuntimeObjectStorePort } from '../../../../../runtime/object-store-adapter';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { FILE_REF_TTL_MS, objectRefOf, signUploadToken, verifyUploadToken } from './presignUpload';

interface CompleteMultipartBody {
  fileId: string;
  parts: { partNumber: number; etag: string }[];
  hash: string;
}

/** API-FILE-002 POST /api/core/dataset/file/completeMultipart */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CompleteMultipartBody>('CompleteMultipartBody', request.body);
    const payload = verifyUploadToken(body.fileId, context);
    const parts: MultipartPartReceipt[] = body.parts.map((part) => ({
      partNumber: part.partNumber,
      etag: part.etag,
      size: 0,
    }));
    const objectStore = createRuntimeObjectStorePort(runtime.clients.objectStore);
    const completed = await objectStore.completeMultipart(
      {
        ref: objectRefOf(payload),
        uploadId: payload.uploadId,
        parts,
        hash: body.hash,
        options: { timeoutMs: 30_000 },
        datasetId: payload.datasetId,
      },
      context,
    );
    const fileRef = signUploadToken({
      kind: 'file',
      teamId: context.tenant.teamId,
      datasetId: payload.datasetId,
      bucket: completed.bucket,
      key: completed.key,
      uploadId: '',
      expiresAt: Date.now() + FILE_REF_TTL_MS,
    });
    response.status(200).json(successResponse({ fileRef }, requestId));
  },
  { validationErrorCode: 501060 },
);
