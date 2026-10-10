import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface TrainingErrorsQuery {
  taskId?: string;
  collectionId?: string;
  datasetId?: string;
  cursor?: string;
  limit?: number;
}

/** API-TASK-002 GET / API-TASK-007 POST /api/core/dataset/training/errors */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const input = request.method === 'POST' ? request.body : request.query;
    const query = parseDto<TrainingErrorsQuery>('TrainingErrorsQuery', input);
    const result = await runtime.processingService.listTaskErrors(
      {
        ...(query.taskId !== undefined ? { taskId: query.taskId } : {}),
        ...(query.collectionId !== undefined ? { collectionId: query.collectionId } : {}),
        ...(query.datasetId !== undefined ? { datasetId: query.datasetId } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        limit: query.limit ?? 20,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    response
      .status(200)
      .json(successResponse({ ...result, cursor: result.cursor ?? '' }, requestId));
  },
  { validationErrorCode: 501070 },
);
