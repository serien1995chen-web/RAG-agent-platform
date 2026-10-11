import { createHash } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

const MAX_IMAGES_PER_REQUEST = 10;
function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}
function normalizeTrainingType(mode: string | undefined): {
  mode: 'chunk' | 'qa' | 'image' | 'imageParse';
  autoIndexes: boolean;
} {
  if (mode === undefined || mode === 'auto') return { mode: 'chunk', autoIndexes: true };
  if (mode === 'image' || mode === 'imageParse' || mode === 'qa' || mode === 'chunk') {
    return { mode, autoIndexes: false };
  }
  return { mode: 'chunk', autoIndexes: false };
}
function stableImageDataId(collectionId: string, file: string): string {
  const digest = createHash('sha256').update(`${collectionId}\u0000${file}`).digest('hex');
  return `img-${digest.slice(0, 32)}`;
}

interface InsertImagesBody {
  collectionId: string;
  files: string[];
  trainingType?: string;
  autoIndexes?: boolean;
}

/** API-DATA-006 POST /api/core/dataset/data/insertImages */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<InsertImagesBody>('InsertImagesBody', request.body);
    if (body.files.length === 0 || body.files.length > MAX_IMAGES_PER_REQUEST) {
      throw apiError(501065, requestId, {
        limit: MAX_IMAGES_PER_REQUEST,
        actual: body.files.length,
      });
    }
    const prefix = `temp/${context.tenant.teamId}/`;
    for (const file of body.files) {
      if (!file.startsWith(prefix)) throw apiError(501009, requestId, {});
    }
    const collection = await runtime.collectionService.getCollection(
      { collectionId: body.collectionId, options: { timeoutMs: 10_000 } },
      context,
    );
    const normalized = normalizeTrainingType(body.trainingType);
    const mode = normalized.mode === 'imageParse' ? 'imageParse' : 'image';
    // 真实逐图处理：创建 ImageAsset/Task 并返回真实每图结果；单图失败可见，不隐藏。
    const items: Array<Record<string, unknown>> = [];
    for (const file of body.files) {
      try {
        const result = await runtime.imageApplicationService.createImage(
          {
            imageId: file,
            datasetId: collection.datasetId,
            collectionId: collection.collectionId,
            dataId: stableImageDataId(collection.collectionId, file),
            bucketName: 'kb-image',
            objectKey: file,
            mimeType: 'image/*',
            size: 0,
            mode,
            options: { timeoutMs: 30_000 },
          },
          context,
        );
        items.push({
          file,
          state: result.state,
          producedItems: result.producedItems,
          ...(result.errorMsg !== undefined ? { errorMsg: result.errorMsg } : {}),
          autoIndexes: normalized.autoIndexes,
        });
      } catch (error) {
        items.push({
          file,
          state: 'failed',
          producedItems: 0,
          errorMsg: error instanceof Error ? error.message : 'image_failed',
          autoIndexes: normalized.autoIndexes,
        });
      }
    }
    response.status(200).json(successResponse({ items }, requestId));
  },
  { validationErrorCode: 501010 },
);
