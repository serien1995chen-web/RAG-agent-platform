import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../../runtime';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import {
  MAX_IMAGES_PER_REQUEST,
  PORT_OPTIONS,
  apiError,
  normalizeTrainingType,
  sourceCollection,
} from '../../../../../../shared/import-source';

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
    const items = body.images.map((imageId) => ({
      imageId,
      state: 'pending',
      mode: normalized.mode,
      autoIndexes: normalized.autoIndexes,
    }));
    response
      .status(200)
      .json(successResponse({ collectionId: created.collectionId, items }, requestId));
  },
  { validationErrorCode: 501010 },
);
