import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface CollectionListQuery {
  datasetId: string;
  parentId?: string;
  type?: string;
  page?: number;
  limit?: number;
}

/** API-COL-001 GET /api/core/dataset/collection/list */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<CollectionListQuery>('CollectionListQuery', {
      ...request.query,
      ...(request.query.page !== undefined ? { page: Number(request.query.page) } : {}),
      ...(request.query.limit !== undefined ? { limit: Number(request.query.limit) } : {}),
    });
    const result = await runtime.collectionService.listCollections(
      {
        datasetId: query.datasetId,
        parentId: query.parentId ?? null,
        page: query.page ?? 1,
        limit: query.limit ?? 20,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    response.status(200).json(successResponse(result, requestId));
  },
  { validationErrorCode: 501070 },
);
