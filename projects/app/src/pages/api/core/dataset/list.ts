import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

interface DatasetListQuery {
  parentId?: string;
  type?: 'dataset' | 'folder';
  page?: number;
  limit?: number;
}

/** API-DS-001 GET /api/core/dataset/list */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<DatasetListQuery>('DatasetListQuery', {
      ...request.query,
      ...(request.query.page !== undefined ? { page: Number(request.query.page) } : {}),
      ...(request.query.limit !== undefined ? { limit: Number(request.query.limit) } : {}),
    });
    const result = await runtime.datasetApi.listDatasets(
      {
        ...(query.parentId !== undefined ? { parentId: query.parentId } : {}),
        ...(query.type !== undefined ? { type: query.type } : {}),
        page: query.page ?? 1,
        limit: query.limit ?? 20,
      },
      context,
    );
    response.status(200).json(successResponse(result, requestId));
  },
  { validationErrorCode: 501004 },
);
