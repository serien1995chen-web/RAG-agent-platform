import { createHash } from 'node:crypto';
import type { CollectionSnapshot } from '@kb/service';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  ImageApplicationService,
  normalizeImageMode,
} from '../../../../../../../../../packages/service/src/modules/item/application/image.service';
import { createImageAssetRepository } from '../../../../../../../../../packages/service/src/modules/item/repository/mongo-image-asset.repository';
import type { ExtendedAppRuntime } from '../../../../../../runtime';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';

function sourceCollection(input: {
  teamId: string;
  datasetId: string;
  name: string;
  sourceRef: string;
  type?: string;
  parentId?: string | null;
}): Omit<CollectionSnapshot, 'collectionId' | 'version' | 'createTime' | 'updateTime'> {
  return {
    teamId: input.teamId,
    datasetId: input.datasetId,
    parentId: input.parentId ?? null,
    type: input.type ?? 'file',
    name: input.name,
    tagIds: [],
    sourceRef: input.sourceRef,
  };
}

const MAX_IMAGES_PER_REQUEST = 10;
const PORT_OPTIONS = { timeoutMs: 30_000 } as const;
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
  if (mode === undefined || mode === 'auto') return normalizeImageMode('auto');
  if (mode === 'image' || mode === 'imageParse') return normalizeImageMode(mode);
  return { mode: 'chunk', autoIndexes: false };
}
function stableImageDataId(collectionId: string, file: string): string {
  const digest = createHash('sha256').update(`${collectionId}\u0000${file}`).digest('hex');
  return digest.slice(0, 24);
}

function createImageService(runtime: ExtendedAppRuntime): {
  createImage: ImageApplicationService['createImage'];
} {
  const injected = (
    runtime as unknown as {
      imageApplicationService?: { createImage: ImageApplicationService['createImage'] };
    }
  ).imageApplicationService;
  if (injected) return injected;
  const assets = createImageAssetRepository(runtime.clients.mongo);
  if (!assets) {
    throw new ApiErrorException(
      createApiError({
        code: 501062,
        requestId: 'image-application',
        params: { dependency: 'image_assets_repository' },
      }),
    );
  }
  const processor =
    runtime.ports.imageTrainingProcessor ??
    ({
      processImage: async (task: { dataId?: string }) => ({
        imageId: task.dataId ?? 'image',
        state: 'success' as const,
        description: 'mock image description',
      }),
    } as never);
  return new ImageApplicationService({
    assets,
    items: runtime.knowledgeItemRepository,
    vectors: runtime.vectorController ?? runtime.ports.vectorController,
    fullText: runtime.fullTextStore ?? runtime.ports.fullTextStore,
    processor,
  });
}

interface CollectionCreateImagesBody {
  datasetId: string;
  images: string[];
  trainingType?: 'chunk' | 'qa' | 'auto' | 'image' | 'imageParse';
}

/** API-COL-008 POST /api/core/dataset/collection/create/images */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateImagesBody>('CollectionCreateImagesBody', request.body);
    if (body.images.length === 0 || body.images.length > MAX_IMAGES_PER_REQUEST) {
      throw apiError(501065, requestId, {
        limit: MAX_IMAGES_PER_REQUEST,
        actual: body.images.length,
      });
    }
    const prefix = `temp/${context.tenant.teamId}/`;
    for (const key of body.images) {
      if (!key.startsWith(prefix)) throw apiError(501009, requestId, {});
    }
    const created = await runtime.collectionRepository.create(
      {
        collection: sourceCollection({
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          name: 'images',
          sourceRef: body.images.join(','),
        }),
        options: PORT_OPTIONS,
      },
      context,
    );
    const normalized = normalizeTrainingType(body.trainingType);
    const mode = normalized.mode === 'imageParse' ? 'imageParse' : 'image';
    // 真实图片生产端：逐图调用 ImageApplicationService，产生 ImageAsset/Data/Task；单图失败可见。
    const items: Array<Record<string, unknown>> = [];
    for (const imageId of body.images) {
      try {
        const result = await createImageService(runtime).createImage(
          {
            imageId,
            datasetId: body.datasetId,
            collectionId: created.collectionId,
            dataId: stableImageDataId(created.collectionId, imageId),
            bucketName: 'kb-image',
            objectKey: imageId,
            mimeType: 'image/*',
            size: 0,
            mode,
            options: PORT_OPTIONS,
          },
          context,
        );
        items.push({
          imageId,
          state: result.state,
          producedItems: result.producedItems,
          ...(result.errorMsg !== undefined ? { errorMsg: result.errorMsg } : {}),
          autoIndexes: normalized.autoIndexes,
        });
      } catch (error) {
        items.push({
          imageId,
          state: 'failed',
          producedItems: 0,
          errorMsg: error instanceof Error ? error.message : 'image_failed',
          autoIndexes: normalized.autoIndexes,
        });
      }
    }
    response
      .status(200)
      .json(successResponse({ collectionId: created.collectionId, items }, requestId));
  },
  { validationErrorCode: 501010 },
);
