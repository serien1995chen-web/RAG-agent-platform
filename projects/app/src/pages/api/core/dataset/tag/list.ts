import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

/** API-TAG-001 GET /api/core/dataset/tag/list */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<{ datasetId: string }>('TagListQuery', request.query);
    const list = await runtime.collectionRepository.tags.list(
      { datasetId: query.datasetId, options: { timeoutMs: 5_000 } },
      context,
    );
    response.status(200).json(successResponse({ list }, requestId));
  },
  { validationErrorCode: 501070 },
);
