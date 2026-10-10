import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface TrainingDetailQuery {
  taskId: string;
}

/** API-TASK-001 GET /api/core/dataset/training/detail */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<TrainingDetailQuery>('TrainingDetailQuery', request.query);
    const result = await runtime.processingService.getTaskDetail(
      { taskId: query.taskId, options: { timeoutMs: 5_000 } },
      context,
    );
    response.status(200).json(successResponse(result, requestId));
  },
  { validationErrorCode: 501070 },
);
