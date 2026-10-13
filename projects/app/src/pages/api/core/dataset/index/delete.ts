import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface IndexDeleteBody {
  dataId: string;
  indexId: string;
  'Idempotency-Key': string;
}

/** API-IDX-003 POST /api/core/dataset/index/delete */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const rawBody = (request.body ?? {}) as Record<string, unknown>;
    const body = parseDto<IndexDeleteBody>('IndexDeleteBody', {
      ...rawBody,
      'Idempotency-Key': request.headers['idempotency-key'] ?? rawBody['Idempotency-Key'],
    });
    const result = await runtime.indexService.deleteIndex(
      { dataId: body.dataId, indexId: body.indexId },
      context,
    );
    response.status(200).json(successResponse(result, requestId));
  },
  { validationErrorCode: 501042 },
);
