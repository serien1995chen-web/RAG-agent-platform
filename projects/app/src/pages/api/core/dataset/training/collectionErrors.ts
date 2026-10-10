import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface CollectionTrainingStatusQuery {
  collectionId: string;
}

/** API-TASK-008 POST /api/core/dataset/training/collectionErrors */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionTrainingStatusQuery>(
      'CollectionTrainingStatusQuery',
      request.body,
    );
    const errors = await runtime.processingService.listCollectionErrors(
      { collectionId: body.collectionId, options: { timeoutMs: 5_000 } },
      context,
    );
    response.status(200).json(successResponse({ errors }, requestId));
  },
  { validationErrorCode: 501070 },
);
