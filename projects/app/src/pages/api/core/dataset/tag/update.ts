import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

/** API-TAG-003 POST /api/core/dataset/tag/update */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<{
      datasetId: string;
      tagId: string;
      name: string;
      version: number;
    }>('TagUpdateBody', request.body);
    const updated = await runtime.collectionRepository.tags.update(
      { ...body, options: { timeoutMs: 5_000 } },
      context,
    );
    response.status(200).json(successResponse(updated, requestId));
  },
  { validationErrorCode: 501043 },
);
