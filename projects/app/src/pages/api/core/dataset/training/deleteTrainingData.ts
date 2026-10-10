import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface TrainingDeleteBody {
  collectionId?: string;
  dataId?: string;
}

/** API-TASK-005 POST /api/core/dataset/training/deleteTrainingData */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<TrainingDeleteBody>('TrainingDeleteBody', request.body);
    const result = await runtime.processingService.deleteTrainingData(
      {
        ...(body.collectionId !== undefined ? { collectionId: body.collectionId } : {}),
        ...(body.dataId !== undefined ? { dataId: body.dataId } : {}),
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    response.status(200).json(successResponse(result, requestId));
  },
  { validationErrorCode: 501070 },
);
