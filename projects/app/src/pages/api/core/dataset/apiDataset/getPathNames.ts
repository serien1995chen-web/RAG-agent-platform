import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface ApiDatasetPathNamesBody {
  datasetId: string;
  apiConfig: unknown;
  nodeId: string;
}

/** API-APIDS-002 POST /api/core/dataset/apiDataset/getPathNames */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<ApiDatasetPathNamesBody>('ApiDatasetPathNamesBody', request.body);
    const provider = runtime.datasetSourceProvider;
    if (!provider.getPathNames) {
      throw new ApiErrorException(
        createApiError({
          code: 501019,
          requestId,
          params: { provider: 'apiFile', status: 'not_implemented' },
        }),
      );
    }
    const path = await provider.getPathNames(
      {
        datasetId: body.datasetId,
        apiConfig: body.apiConfig as never,
        nodeId: body.nodeId,
        options: { timeoutMs: 30_000 },
      },
      context,
    );
    response.status(200).json(successResponse({ path }, requestId));
  },
  { validationErrorCode: 501017 },
);
