import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface TrainingUpdateBody {
  dataId?: string;
  collectionId?: string;
  datasetId?: string;
  mode: string;
}

/** API-TASK-004 PUT /api/core/dataset/training/updateTrainingData */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<TrainingUpdateBody>('TrainingUpdateBody', request.body);
    const result = await runtime.processingService.updateTrainingData(
      {
        ...(body.dataId !== undefined ? { dataId: body.dataId } : {}),
        ...(body.collectionId !== undefined ? { collectionId: body.collectionId } : {}),
        ...(body.datasetId !== undefined ? { datasetId: body.datasetId } : {}),
        mode: body.mode,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    response.status(200).json(successResponse(result, requestId));
  },
  { validationErrorCode: 501048 },
);
