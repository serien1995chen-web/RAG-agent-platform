import { createHash, randomUUID } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime';
import { successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';
import { FILE_REF_TTL_MS, signUploadToken } from '../../core/dataset/file/presignUpload';

interface DemoUploadBody {
  datasetId: string;
}

/** 8x8 PNG 测试夹具：真实图片字节，不是业务假数据。 */
const DEMO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP478+AFWEXHbQSAOBoU4FwyX8rAAAAAElFTkSuQmCC';

/**
 * demo-only 上传辅助（不登记到 87 条公开路由/契约）：
 * 走真实的 prepareMultipart → uploadPart → completeMultipart，返回真实 fileRef。
 * 浏览器 Web Crypto 无法计算 S3 multipart MD5 ETag，因此由服务端完成该步骤。
 */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const raw =
      typeof request.body === 'object' && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};
    const body: DemoUploadBody = {
      datasetId: typeof raw['datasetId'] === 'string' ? raw['datasetId'] : '',
    };
    if (!/^[0-9a-f]{24}$/i.test(body.datasetId)) {
      throw new ApiErrorException(
        createApiError({ code: 501030, requestId, params: { limit: 1, actual: 0 } }),
      );
    }
    await runtime.datasetApi.getDatasetDetail(body.datasetId, context);

    const bytes = Buffer.from(DEMO_PNG_BASE64, 'base64');
    const key = `dataset/${body.datasetId}/uploads/${randomUUID()}.png`;
    const ref = { bucket: runtime.config.system.s3.bucket, key };
    const options = { timeoutMs: 30_000 };
    const prepared = await runtime.ports.objectStore.prepareMultipart(
      { ref, parts: 1, options, datasetId: body.datasetId },
      context,
    );
    if (!prepared.multipartUploadId) {
      throw new ApiErrorException(
        createApiError({
          code: 501060,
          requestId,
          params: { fileId: '', uploadId: '', missingParts: [1] },
        }),
      );
    }
    const part = await runtime.ports.objectStore.uploadPart(
      {
        ref,
        uploadId: prepared.multipartUploadId,
        partNumber: 1,
        body: bytes,
        checksum: createHash('sha256').update(bytes).digest('hex'),
        options,
        datasetId: body.datasetId,
      },
      context,
    );
    // S3 multipart ETag：md5(分片 MD5 原始摘要) + '-' + 分片数；单分片即 md5(etag 十六进制字节)+'-1'。
    const hash = `${createHash('md5').update(Buffer.from(part.etag, 'hex')).digest('hex')}-1`;
    const completed = await runtime.ports.objectStore.completeMultipart(
      {
        ref,
        uploadId: prepared.multipartUploadId,
        parts: [{ partNumber: 1, etag: part.etag, size: bytes.length }],
        hash,
        options,
        datasetId: body.datasetId,
      },
      context,
    );
    const fileRef = signUploadToken({
      kind: 'file',
      teamId: context.tenant.teamId,
      datasetId: body.datasetId,
      bucket: completed.bucket,
      key: completed.key,
      uploadId: '',
      expiresAt: Date.now() + FILE_REF_TTL_MS,
    });
    response.status(200).json(successResponse({ fileRef, size: bytes.length }, requestId));
  },
  { validationErrorCode: 501030 },
);
