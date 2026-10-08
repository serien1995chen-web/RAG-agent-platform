import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

/** API-DATA-002 GET /api/core/dataset/data/detail */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<{ dataId: string }>('DataDetailQuery', request.query);
    const item = await runtime.knowledgeItemService.getItem(
      { dataId: query.dataId, options: { timeoutMs: 5_000 } },
      context,
    );
    if (!item) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId,
          params: { resourceType: 'data', resourceId: query.dataId },
        }),
      );
    }
    const { imageId: _imageId, ...safeItem } = item;
    response.status(200).json(
      successResponse(
        {
          data: safeItem,
          indexes: item.indexes,
          metadata: item.metadata ?? {},
        },
        requestId,
      ),
    );
  },
  { validationErrorCode: 501070 },
);
