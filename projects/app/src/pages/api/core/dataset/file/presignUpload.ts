import { randomUUID } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

const MAX_RAW_TEXT_BYTES = 10 * 1024 * 1024;

interface PresignUploadBody {
  datasetId: string;
  filename: string;
  size: number;
  mime: string;
}

function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

/** API-FILE-001 POST /api/core/dataset/file/presignUpload */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<PresignUploadBody>('PresignUploadBody', request.body);
    if (body.size > MAX_RAW_TEXT_BYTES) {
      throw apiError(501065, requestId, { limitBytes: MAX_RAW_TEXT_BYTES, actualBytes: body.size });
    }
    // 先校验 Dataset 属于认证团队，再构造对象 scope。
    await runtime.datasetApi.getDatasetDetail(body.datasetId, context);
    const store = runtime.clients.objectStore;
    const fileId = randomUUID();
    const key = `dataset/${body.datasetId}/${fileId}`;
    const objectContext = { teamId: context.tenant.teamId, datasetId: body.datasetId };
    // 真实创建 multipart session：prepareMultipart → uploadId，写入 FileUploadService。
    const prepared = await store.prepareMultipart(
      { ref: { bucket: 'kb-source', key }, parts: 1 },
      objectContext,
    );
    const uploadId = prepared.multipartUploadId ?? fileId;
    runtime.fileUploadService.createSession({
      fileId,
      teamId: context.tenant.teamId,
      datasetId: body.datasetId,
      key,
      uploadId,
      bucket: 'kb-source',
    });
    response.status(200).json(
      successResponse(
        {
          uploadUrl: `/api/core/dataset/file/uploadPart?fileId=${fileId}`,
          fileId,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
        requestId,
      ),
    );
  },
  { validationErrorCode: 501065 },
);
