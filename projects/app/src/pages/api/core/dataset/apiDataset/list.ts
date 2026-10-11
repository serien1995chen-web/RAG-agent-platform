import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

interface ApiDatasetListBody {
  datasetId: string;
  apiConfig: unknown;
  parentId?: string;
  keyword?: string;
}

interface ApiDatasetClient {
  list(input: {
    datasetId: string;
    apiConfig: unknown;
    parentId?: string;
    keyword?: string;
  }): Promise<{ list: unknown[]; isImported: boolean }>;
}

/** API-APIDS-003 POST /api/core/dataset/apiDataset/list */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    await authenticateRequest(runtime, request, requestId);
    const body = parseDto<ApiDatasetListBody>('ApiDatasetListBody', request.body);
    const client = (runtime.ports as { apiDatasetClient?: ApiDatasetClient }).apiDatasetClient;
    if (!client) throw apiError(501017, requestId, { provider: 'apiDataset' });
    try {
      const result = await client.list({
        datasetId: body.datasetId,
        apiConfig: body.apiConfig,
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        ...(body.keyword !== undefined ? { keyword: body.keyword } : {}),
      });
      response
        .status(200)
        .json(successResponse({ list: result.list, isImported: result.isImported }, requestId));
    } catch {
      throw apiError(501039, requestId, { provider: 'apiDataset' });
    }
  },
  { validationErrorCode: 501039 },
);
