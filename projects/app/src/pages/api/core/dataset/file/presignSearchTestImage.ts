import { randomUUID } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { createRuntimeObjectStorePort } from '../../../../../runtime/object-store-adapter';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { UPLOAD_PART_PATH, signUploadToken } from './presignUpload';

interface PresignSearchTestImageBody {
  filename: string;
  size: number;
  mime: string;
}

// 设计规定 search-test 图片 temp key 2 小时有效。
const SEARCH_IMAGE_TTL_MS = 2 * 60 * 60 * 1000;

function extensionOf(filename: string): string {
  const match = /(\.[A-Za-z0-9]{1,12})$/.exec(filename);
  return match?.[1] ?? '';
}

/** API-FILE-005 POST /api/core/dataset/file/presignSearchTestImage */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<PresignSearchTestImageBody>('PresignSearchTestImageBody', request.body);
    const limits = runtime.config.datasetRuntime;
    if (!body.mime.toLowerCase().startsWith('image/')) {
      throw new ApiErrorException(
        createApiError({
          code: 501010,
          requestId,
          params: { capability: 'image', datasetId: '' },
        }),
      );
    }
    if (body.size > limits.maxRequestBodyBytes) {
      throw new ApiErrorException(
        createApiError({
          code: 501065,
          requestId,
          params: { limitBytes: limits.maxRequestBodyBytes, actualBytes: body.size, urlHash: '' },
        }),
      );
    }
    const expiresAt = Date.now() + SEARCH_IMAGE_TTL_MS;
    const key = `temp/${context.tenant.teamId}/${expiresAt}/${randomUUID()}${extensionOf(
      body.filename,
    )}`;
    const options = { timeoutMs: 15_000 };
    const objectStore = createRuntimeObjectStorePort(runtime.clients.objectStore);
    const prepared = await objectStore.prepareMultipart(
      { ref: { bucket: runtime.config.system.s3.bucket, key }, parts: 1, options },
      context,
    );
    // url 内嵌 fileId token，客户端可直接对返回 url 发起 multipart 上传而不会 501061。
    const fileId = signUploadToken({
      kind: 'upload',
      teamId: context.tenant.teamId,
      datasetId: '',
      bucket: prepared.bucket,
      key: prepared.key,
      uploadId: prepared.multipartUploadId ?? '',
      expiresAt,
    });
    response.status(200).json(
      successResponse(
        {
          url: `${UPLOAD_PART_PATH}?fileId=${encodeURIComponent(fileId)}`,
          key,
          expiresAt: new Date(expiresAt).toISOString(),
        },
        requestId,
      ),
    );
  },
  { validationErrorCode: 501065 },
);
