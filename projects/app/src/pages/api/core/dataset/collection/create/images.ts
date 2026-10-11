import type { CollectionSnapshot } from '@kb/service';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
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
const PORT_OPTIONS = { timeoutMs: 10_000 } as const;
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
