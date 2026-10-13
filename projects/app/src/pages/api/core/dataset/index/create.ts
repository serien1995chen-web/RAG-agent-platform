import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface IndexCreateBody {
  dataId: string;
  type: string;
  text: string;
}

/** API-IDX-001 POST /api/core/dataset/index/create */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<IndexCreateBody>('IndexCreateBody', request.body);
    const result = await runtime.indexService.createIndex(
      { dataId: body.dataId, type: body.type, text: body.text },
      context,
    );
    response.status(200).json(successResponse(result, requestId));
  },
  { validationErrorCode: 501041 },
);
