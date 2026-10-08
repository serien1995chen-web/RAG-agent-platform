import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

/** API-TAG-005 POST /api/core/dataset/tag/addToCollections */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<{
      datasetId: string;
      tagId: string;
      collectionIds: string[];
    }>('TagBindingBody', request.body);
    const result = await runtime.collectionRepository.tags.addToCollections(
      { ...body, options: { timeoutMs: 5_000 } },
      context,
    );
    response.status(200).json(successResponse(result, requestId));
  },
  { validationErrorCode: 501045 },
);
