import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

/** API-TAG-004 POST /api/core/dataset/tag/delete */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const rawBody = (request.body ?? {}) as Record<string, unknown>;
    const body = parseDto<{ datasetId: string; tagId: string }>('TagDeleteBody', {
      ...rawBody,
      'Idempotency-Key': request.headers['idempotency-key'] ?? rawBody['Idempotency-Key'],
    });
    const deleted = await runtime.collectionRepository.tags.delete(
      { ...body, options: { timeoutMs: 5_000 } },
      context,
    );
    response.status(200).json(successResponse(deleted, requestId));
  },
  { validationErrorCode: 501070 },
);
