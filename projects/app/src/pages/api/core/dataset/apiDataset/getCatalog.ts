import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface ApiDatasetCatalogBody {
  datasetId: string;
  apiConfig: unknown;
  parentId?: string;
}

/** API-APIDS-001 POST /api/core/dataset/apiDataset/getCatalog */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<ApiDatasetCatalogBody>('ApiDatasetCatalogBody', request.body);
    const provider = runtime.datasetSourceProvider;
    if (!provider.getCatalog) {
      throw new ApiErrorException(
        createApiError({
          code: 501019,
          requestId,
          params: { provider: 'apiFile', status: 'not_implemented' },
        }),
      );
    }
    const nodes = await provider.getCatalog(
      {
        datasetId: body.datasetId,
        apiConfig: body.apiConfig as never,
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        options: { timeoutMs: 30_000 },
      },
      context,
    );
    response.status(200).json(successResponse({ nodes }, requestId));
  },
  { validationErrorCode: 501017 },
);
