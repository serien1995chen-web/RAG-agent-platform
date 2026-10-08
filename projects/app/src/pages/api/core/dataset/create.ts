import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

interface DatasetCreateBody {
  name: string;
  type: 'dataset' | 'folder';
  models: { embeddingModel: string; llmModel?: string; vlmModel?: string; rerankModel?: string };
  parentId?: string;
}

/** API-DS-002 POST /api/core/dataset/create */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<DatasetCreateBody>('DatasetCreateBody', request.body);
    const created = await runtime.datasetApi.createDataset(
      {
        name: body.name,
        type: body.type,
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        vectorModel: body.models.embeddingModel,
      },
      context,
    );
    response.status(200).json(successResponse(created, requestId));
  },
  { validationErrorCode: 501001 },
);
