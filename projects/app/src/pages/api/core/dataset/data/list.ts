import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface DataListQuery {
  collectionId: string;
  page?: number;
  limit?: number;
  search?: string;
}

/** API-DATA-001 GET /api/core/dataset/data/list */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<DataListQuery>('DataListQuery', {
      ...request.query,
      ...(request.query.page !== undefined ? { page: Number(request.query.page) } : {}),
      ...(request.query.limit !== undefined ? { limit: Number(request.query.limit) } : {}),
    });
    const result = await runtime.knowledgeItemService.listItems(
      {
        collectionId: query.collectionId,
        page: query.page ?? 1,
        limit: query.limit ?? 20,
        ...(query.search !== undefined ? { search: query.search } : {}),
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    response.status(200).json(
      successResponse(
        {
          total: result.total,
          list: result.list.map(({ imageId: _imageId, ...item }) => item),
        },
        requestId,
      ),
    );
  },
  { validationErrorCode: 501070 },
);
