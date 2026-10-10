import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { readIdempotencyKey } from '../../../../../shared/api/idempotency';

interface TrainingResumeBody {
  taskId: string;
  reason: string;
  'Idempotency-Key': string;
}

/** API-TASK-003 POST /api/core/dataset/training/resume */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const headerIdempotencyKey = readIdempotencyKey(request);
    const body = parseDto<TrainingResumeBody>('TrainingResumeBody', {
      ...(typeof request.body === 'object' && request.body !== null ? request.body : {}),
      ...(headerIdempotencyKey !== null ? { 'Idempotency-Key': headerIdempotencyKey } : {}),
    });
    const result = await runtime.processingService.resumeTask(
      { taskId: body.taskId, reason: body.reason, options: { timeoutMs: 5_000 } },
      context,
    );
    response.status(200).json(successResponse(result, requestId));
  },
  { validationErrorCode: 501006 },
);
