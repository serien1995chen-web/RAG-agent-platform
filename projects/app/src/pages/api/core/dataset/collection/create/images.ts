import { ApiErrorException, createApiError } from '@kb/contracts';
import { normalizeImageMode, type ImageMode } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import {
  assertImageCapability,
  ingestResolvedImages,
  resolveImageSources,
} from '../../../../../../shared/api/image-ingest';

interface CollectionCreateImagesBody {
  datasetId: string;
  images: string[];
  trainingType?: 'chunk' | 'qa' | 'auto' | 'image' | 'imageParse';
  autoIndexes?: boolean;
  imageIndex?: boolean;
}

function normalizeRequestedMode(
  requested: NonNullable<CollectionCreateImagesBody['trainingType']>,
  requestId: string,
): { trainingMode: ImageMode; autoIndexes: boolean } {
  if (requested === 'qa') {
    throw new ApiErrorException(
      createApiError({
        code: 501001,
        requestId,
        params: { type: 'qa' },
      }),
    );
  }
  if (requested === 'auto') return normalizeImageMode('auto');
  return normalizeImageMode(requested);
}

/** API-COL-008 POST /api/core/dataset/collection/create/images */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateImagesBody>('CollectionCreateImagesBody', request.body);
    const { trainingMode, autoIndexes } = normalizeRequestedMode(
      body.trainingType ?? 'auto',
      requestId,
    );
    assertImageCapability(runtime, requestId);

    const detail = await runtime.datasetApi.getDatasetDetail(body.datasetId, context);
    const options = { timeoutMs: 60_000 };
    // 先完成来源校验与对象读取；任何失败都发生在集合创建之前。
    const resolved = await resolveImageSources(runtime, context, body.datasetId, body.images);

    const created = await runtime.collectionRepository.create(
      {
        collection: {
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          parentId: null,
          type: 'image',
          name: 'images',
          tagIds: [],
          trainingMode,
          autoIndexes,
        },
        options,
      },
      context,
    );

    await runtime.collectionRepository.markTrainingState(
      {
        collectionId: created.collectionId,
        trainingState: 'running',
        remainingTraining: resolved.length,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    const items = await ingestResolvedImages(runtime, context, {
      datasetId: body.datasetId,
      collectionId: created.collectionId,
      indexVersion: detail.dataset.indexVersion,
      mode: trainingMode,
      resolved,
      options,
    });
    const failed = items.some(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        (item as { state?: string }).state !== 'success',
    );
    await runtime.collectionRepository.markTrainingState(
      {
        collectionId: created.collectionId,
        trainingState: failed ? 'error' : 'ready',
        remainingTraining: 0,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    response
      .status(200)
      .json(successResponse({ collectionId: created.collectionId, items }, requestId));
  },
  { validationErrorCode: 501065 },
);
