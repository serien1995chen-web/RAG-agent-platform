import { ApiErrorException, createApiError } from '@kb/contracts';
import type { JsonValue } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  ImageApplicationService,
  normalizeImageMode,
} from '../../../../../../../../packages/service/src/modules/item/application/index';
import { createImageAssetRepository } from '../../../../../../../../packages/service/src/modules/item/repository/index';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface InsertImagesBody {
  collectionId: string;
  files: string[];
  trainingType?: 'chunk' | 'qa' | 'auto' | 'image' | 'imageParse';
  autoIndexes?: boolean;
}

const IMAGE_MODES = new Set(['image', 'imageParse']);

/** API-DATA-006 POST /api/core/dataset/data/insertImages */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<InsertImagesBody>('InsertImagesBody', request.body);
    const requested = body.trainingType ?? 'auto';
    const normalized =
      requested === 'image' || requested === 'imageParse' || requested === 'auto'
        ? normalizeImageMode(requested)
        : { trainingMode: requested, autoIndexes: body.autoIndexes ?? false };
    const options = { timeoutMs: 60_000 };
    const collection = await runtime.collectionService.getCollection(
      { collectionId: body.collectionId, options },
      context,
    );
    const items: JsonValue[] = [];
    if (IMAGE_MODES.has(normalized.trainingMode)) {
      const assets = createImageAssetRepository(runtime.clients.mongo as never);
      const fullText = runtime.fullTextStore;
      if (!assets || !fullText) {
        throw new ApiErrorException(
          createApiError({ code: 501062, requestId, params: { dependency: 'image_pipeline' } }),
        );
      }
      const service = new ImageApplicationService({
        assets,
        items: runtime.knowledgeItemRepository,
        vectors: runtime.vectorController,
        fullText,
        processor: runtime.ports.imageTrainingProcessor,
      });
      for (let index = 0; index < body.files.length; index += 1) {
        const source = body.files[index] ?? '';
        const dataId = `${body.collectionId}:${index}`;
        const result = await service.createImage(
          {
            imageId: dataId,
            datasetId: collection.datasetId,
            collectionId: body.collectionId,
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
    response.status(200).json(successResponse({ items }, requestId));
  },
  { validationErrorCode: 501065 },
);
