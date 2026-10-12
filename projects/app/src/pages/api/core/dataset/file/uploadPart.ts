import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { createRuntimeObjectStorePort } from '../../../../../runtime/object-store-adapter';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { objectRefOf, readMultipartForm, verifyUploadToken } from './presignUpload';

interface UploadPartForm {
  uploadId: string;
  partNumber: number;
  chunk: string;
  checksum: string;
}

/** API-FILE-007 POST /api/core/dataset/file/uploadPart */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const rawFileId = request.query.fileId;
    const fileId = Array.isArray(rawFileId) ? rawFileId[0] : rawFileId;
    const payload = verifyUploadToken(fileId, context);
    const form = readMultipartForm(request);
    const chunk = form.files.chunk?.content ?? new Uint8Array(0);
    const fields = parseDto<UploadPartForm>('UploadPartForm', {
      uploadId: form.fields.uploadId ?? payload.uploadId,
      partNumber: Number(form.fields.partNumber),
      checksum: form.fields.checksum ?? '',
      chunk,
    });
    const objectStore = createRuntimeObjectStorePort(runtime.clients.objectStore);
    const options = { timeoutMs: 30_000 };
    const receipt = await objectStore.uploadPart(
      {
        ref: objectRefOf(payload),
        uploadId: payload.uploadId,
        partNumber: fields.partNumber,
        body: chunk,
        checksum: fields.checksum,
        options,
        datasetId: payload.datasetId,
      },
      context,
    );
    response
      .status(200)
      .json(
        successResponse(
          { etag: receipt.etag, partNumber: receipt.partNumber, size: receipt.size },
          requestId,
        ),
      );
  },
  { validationErrorCode: 501065 },
);
