import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

/** API-PATH-003 POST /api/core/dataset/move */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<{ datasetId: string; targetParentId?: string; version: number }>(
      'DatasetMoveBody',
      request.body,
    );
    const updated = await runtime.datasetApi.updateDataset(
      {
        datasetId: body.datasetId,
        version: body.version,
        parentId: body.targetParentId ?? null,
      },
      context,
    );
    response.status(200).json(successResponse(updated, requestId));
  },
  { validationErrorCode: 501046 },
);
