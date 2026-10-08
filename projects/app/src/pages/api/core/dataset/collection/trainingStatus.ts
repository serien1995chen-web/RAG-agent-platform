import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface CollectionTrainingStatusQuery {
  collectionId: string;
}

/** API-COL-016 GET /api/core/dataset/collection/trainingStatus */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<CollectionTrainingStatusQuery>(
      'CollectionTrainingStatusQuery',
      request.query,
    );
    await runtime.collectionService.getCollection(
      { collectionId: query.collectionId, options: { timeoutMs: 5_000 } },
      context,
    );
    response
      .status(200)
      .json(successResponse({ trainingState: 'ready', stage: 'mongo', remaining: 0 }, requestId));
  },
  { validationErrorCode: 501070 },
);
