import { ApiErrorException, createApiError } from '@kb/contracts';
import type { JsonValue } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  ImageApplicationService,
  normalizeImageMode,
} from '../../../../../../../../../packages/service/src/modules/item/application/index';
import { createImageAssetRepository } from '../../../../../../../../../packages/service/src/modules/item/repository/index';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';

interface CollectionCreateImagesBody {
  datasetId: string;
  images: string[];
  trainingType?: 'chunk' | 'qa' | 'auto' | 'image' | 'imageParse';
  autoIndexes?: boolean;
  imageIndex?: boolean;
}

const IMAGE_MODES = new Set(['image', 'imageParse']);

/** API-COL-008 POST /api/core/dataset/collection/create/images */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateImagesBody>('CollectionCreateImagesBody', request.body);
    const requested = body.trainingType ?? 'auto';
    const normalized =
      requested === 'image' || requested === 'imageParse' || requested === 'auto'
        ? normalizeImageMode(requested)
        : { trainingMode: requested, autoIndexes: body.autoIndexes ?? false };
    const options = { timeoutMs: 60_000 };
    const created = await runtime.collectionRepository.create(
      {
        collection: {
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          parentId: null,
          type: 'image',
          name: 'images',
          tagIds: [],
          // ISSUE-002：训练模式独立落库，chunkPolicy 保持自身切分语义。
          trainingMode: normalized.trainingMode,
          autoIndexes: normalized.autoIndexes,
        },
        options,
      },
      context,
    );

    const items: JsonValue[] = [];
    if (IMAGE_MODES.has(normalized.trainingMode)) {
      const assets = createImageAssetRepository(runtime.clients.mongo as never);
      const fullText = runtime.fullTextStore;
      if (!assets || !fullText) {
        throw new ApiErrorException(
          createApiError({
            code: 501062,
            requestId,
            params: { dependency: 'image_pipeline' },
          }),
        );
      }
      const service = new ImageApplicationService({
        assets,
        items: runtime.knowledgeItemRepository,
        vectors: runtime.vectorController,
        fullText,
        processor: runtime.ports.imageTrainingProcessor,
      });
      for (let index = 0; index < body.images.length; index += 1) {
        const source = body.images[index] ?? '';
        const dataId = `${created.collectionId}:${index}`;
        const result = await service.createImage(
          {
            imageId: dataId,
            datasetId: body.datasetId,
            collectionId: created.collectionId,
            dataId,
            bucketName: runtime.config.system.s3.bucket,
            objectKey: source,
            mimeType: 'image/png',
            size: 0,
            mode: normalized.trainingMode as 'image' | 'imageParse',
            options,
          },
          context,
        );
        items.push({ source, state: result.state, errorMsg: result.errorMsg ?? null });
      }
    }
    response
      .status(200)
      .json(successResponse({ collectionId: created.collectionId, items }, requestId));
  },
  { validationErrorCode: 501065 },
);
