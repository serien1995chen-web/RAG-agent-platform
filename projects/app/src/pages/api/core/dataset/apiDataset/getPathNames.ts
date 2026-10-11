import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

interface ApiDatasetPathNamesBody {
  datasetId: string;
  apiConfig: unknown;
  nodeId: string;
}

interface ApiDatasetClient {
  getPathNames(input: { datasetId: string; apiConfig: unknown; nodeId: string }): Promise<string>;
}

/** API-APIDS-002 POST /api/core/dataset/apiDataset/getPathNames */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<ApiDatasetPathNamesBody>('ApiDatasetPathNamesBody', request.body);
    // 先校验 Dataset 归属，再调用 Provider。
    await runtime.datasetApi.getDatasetDetail(body.datasetId, context);
    const client = (runtime.ports as { apiDatasetClient?: ApiDatasetClient }).apiDatasetClient;
    if (!client) throw apiError(501017, requestId, { provider: 'apiDataset' });
    try {
      const path = await client.getPathNames({
        datasetId: body.datasetId,
        apiConfig: body.apiConfig,
        nodeId: body.nodeId,
      });
      response.status(200).json(successResponse({ path }, requestId));
    } catch {
      throw apiError(501019, requestId, { provider: 'apiDataset' });
    }
  },
  { validationErrorCode: 501017 },
);
