import { ApiErrorException, createApiError } from '@kb/contracts';
import { normalizeImageMode, type ImageMode } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import {
  assertImageCapability,
  ingestResolvedImages,
  resolveImageSources,
} from '../../../../../shared/api/image-ingest';

interface InsertImagesBody {
  collectionId: string;
  files: string[];
  trainingType?: 'chunk' | 'qa' | 'auto' | 'image' | 'imageParse';
  autoIndexes?: boolean;
}

function normalizeRequestedMode(
  requested: NonNullable<InsertImagesBody['trainingType']>,
  requestId: string,
): { trainingMode: ImageMode } {
  if (requested === 'qa') {
    throw new ApiErrorException(
      createApiError({
        code: 501001,
        requestId,
        params: { type: 'qa' },
      }),
    );
  }
  return {
    trainingMode: requested === 'auto' ? normalizeImageMode('auto').trainingMode : requested,
  };
}

/** API-DATA-006 POST /api/core/dataset/data/insertImages */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<InsertImagesBody>('InsertImagesBody', request.body);
    const { trainingMode } = normalizeRequestedMode(body.trainingType ?? 'auto', requestId);
    assertImageCapability(runtime, requestId);

    const options = { timeoutMs: 60_000 };
    const collection = await runtime.collectionService.getCollection(
      { collectionId: body.collectionId, options },
      context,
    );
    if (collection.type !== 'images') {
      throw new ApiErrorException(
        createApiError({
          code: 501001,
          requestId,
          params: { type: collection.type },
        }),
      );
    }
    const detail = await runtime.datasetApi.getDatasetDetail(collection.datasetId, context);
    const resolved = await resolveImageSources(runtime, context, collection.datasetId, body.files);

    await runtime.collectionRepository.markTrainingState(
      {
        collectionId: body.collectionId,
        trainingState: 'running',
        remainingTraining: resolved.length,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    const items = await ingestResolvedImages(runtime, context, {
      datasetId: collection.datasetId,
      collectionId: body.collectionId,
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
        collectionId: body.collectionId,
        trainingState: failed ? 'error' : 'ready',
        remainingTraining: 0,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    response.status(200).json(successResponse({ items }, requestId));
  },
  { validationErrorCode: 501065 },
);
