import { ApiErrorException } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { createRuntimeObjectStorePort } from '../../../../../runtime/object-store-adapter';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { objectRefOf, verifyUploadToken } from './presignUpload';

interface AbortMultipartBody {
  fileId: string;
  uploadId: string;
}

/** API-FILE-003 POST /api/core/dataset/file/abortMultipart */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<AbortMultipartBody>('AbortMultipartBody', request.body);
    const payload = verifyUploadToken(body.fileId, context);
    const objectStore = createRuntimeObjectStorePort(runtime.clients.objectStore);
    try {
      const result = await objectStore.abort(
        {
          ref: objectRefOf(payload),
          options: { timeoutMs: 15_000 },
          datasetId: payload.datasetId,
        },
        context,
      );
      response.status(200).json(successResponse({ aborted: result.aborted }, requestId));
    } catch (error) {
      // 幂等中止：会话已不存在时仍返回 aborted=true，不产生残留。
      if (
        error instanceof ApiErrorException &&
        (error.error.code === 501015 || error.error.code === 501016)
      ) {
        response.status(200).json(successResponse({ aborted: true }, requestId));
        return;
      }
      throw error;
    }
  },
  { validationErrorCode: 501061 },
);
