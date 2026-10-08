import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface CollectionTrainingStatusQuery {
  collectionId: string;
}

/** API-COL-011 GET /api/core/dataset/collection/detail */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<CollectionTrainingStatusQuery>(
      'CollectionTrainingStatusQuery',
      request.query,
    );
    const collection = await runtime.collectionService.getCollection(
      { collectionId: query.collectionId, options: { timeoutMs: 5_000 } },
      context,
    );
    response.status(200).json(
      successResponse(
        {
          sourceRef: collection.sourceRef ?? '',
          trainingStatus: 'ready',
          remainingTraining: 0,
        },
        requestId,
      ),
    );
  },
  { validationErrorCode: 501070 },
);
