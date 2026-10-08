import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

interface DatasetDetailQuery {
  datasetId: string;
}

/** API-DS-003 GET /api/core/dataset/detail */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<DatasetDetailQuery>('DatasetDetailQuery', request.query);
    const detail = await runtime.datasetApi.getDatasetDetail(query.datasetId, context);
    const permissionSnapshot = await runtime.datasetPermission.getPermission(
      { datasetId: query.datasetId, options: { timeoutMs: 5_000 } },
      context,
    );
    response.status(200).json(
      successResponse(
        {
          dataset: detail.dataset,
          permissionSnapshot,
          stats: detail.stats,
        },
        requestId,
      ),
    );
  },
  { validationErrorCode: 501070 },
);
