import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface IndexUpdateBody {
  dataId: string;
  indexId: string;
  text: string;
  version: number;
}

/** API-IDX-002 POST /api/core/dataset/index/update */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<IndexUpdateBody>('IndexUpdateBody', request.body);
    const result = await runtime.indexService.updateIndex(
      { dataId: body.dataId, indexId: body.indexId, text: body.text, version: body.version },
      context,
    );
    response.status(200).json(successResponse(result, requestId));
  },
  { validationErrorCode: 501067 },
);
