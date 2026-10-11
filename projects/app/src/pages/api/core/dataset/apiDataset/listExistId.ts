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

interface ApiDatasetExistIdQuery {
  datasetId: string;
  apiConfigId: string;
}

interface ApiDatasetClient {
  listExistId(input: { datasetId: string; apiConfigId: string }): Promise<unknown[]>;
}

/** API-APIDS-004 GET /api/core/dataset/apiDataset/listExistId */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<ApiDatasetExistIdQuery>('ApiDatasetExistIdQuery', request.query);
    await runtime.datasetApi.getDatasetDetail(query.datasetId, context);
    const client = (runtime.ports as { apiDatasetClient?: ApiDatasetClient }).apiDatasetClient;
    if (!client) throw apiError(501017, requestId, { provider: 'apiDataset' });
    const fileIds = await client.listExistId({
      datasetId: query.datasetId,
      apiConfigId: query.apiConfigId,
    });
    if (!context.tenant.teamId) throw apiError(501061, requestId, {});
    response.status(200).json(successResponse({ fileIds }, requestId));
  },
  { validationErrorCode: 501070 },
);
