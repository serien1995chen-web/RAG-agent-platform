import { ApiErrorException, createApiError } from '@kb/contracts';
import type { CollectionSnapshot } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface VirtualCollectionQuery {
  collectionId: string;
}

/** API-VIRT-001 GET /api/core/dataset/collection/virtual */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<VirtualCollectionQuery>('VirtualCollectionQuery', request.query);
    let collection: CollectionSnapshot;
    try {
      collection = await runtime.collectionService.getCollection(
        { collectionId: query.collectionId, options: { timeoutMs: 5_000 } },
        context,
      );
    } catch (error) {
      if (error instanceof ApiErrorException && error.error.code !== 501999) throw error;
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId,
          params: { resourceType: 'collection', resourceId: query.collectionId },
        }),
      );
    }
    response
      .status(200)
      .json(
        successResponse(
          { virtual: collection.type === 'virtual', sourceRef: collection.sourceRef ?? '' },
          requestId,
        ),
      );
  },
  { validationErrorCode: 501070 },
);
