import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface TrainingQueueQuery {
  datasetId: string;
}

/** API-TASK-009 GET /api/core/dataset/training/hasError */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<TrainingQueueQuery>('TrainingQueueQuery', request.query);
    const hasError = await runtime.processingService.hasError(
      { datasetId: query.datasetId, options: { timeoutMs: 5_000 } },
      context,
    );
    response.status(200).json(successResponse({ hasError }, requestId));
  },
  { validationErrorCode: 501070 },
);
