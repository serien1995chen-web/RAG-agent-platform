import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

/** API-TAG-002 POST /api/core/dataset/tag/create */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<{ datasetId: string; name: string }>('TagCreateBody', request.body);
    const created = await runtime.collectionRepository.tags.create(
      { ...body, options: { timeoutMs: 5_000 } },
      context,
    );
    response.status(200).json(successResponse(created, requestId));
  },
  { validationErrorCode: 501043 },
);
