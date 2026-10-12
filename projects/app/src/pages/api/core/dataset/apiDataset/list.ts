import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface ApiDatasetListBody {
  datasetId: string;
  apiConfig: unknown;
  parentId?: string;
  keyword?: string;
}

/** API-APIDS-003 POST /api/core/dataset/apiDataset/list */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<ApiDatasetListBody>('ApiDatasetListBody', request.body);
    const provider = runtime.datasetSourceProvider;
    if (!provider.list) {
      throw new ApiErrorException(
        createApiError({
          code: 501019,
          requestId,
          params: { provider: 'apiFile', status: 'not_implemented' },
        }),
      );
    }
    const list = await provider.list(
      {
        datasetId: body.datasetId,
        apiConfig: body.apiConfig as never,
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        ...(body.keyword !== undefined ? { keyword: body.keyword } : {}),
        options: { timeoutMs: 30_000 },
      },
      context,
    );
    const page = await runtime.collectionRepository.list(
      { datasetId: body.datasetId, page: 1, limit: 100, options: { timeoutMs: 5_000 } },
      context,
    );
    const isImported = page.list.some((collection) =>
      (collection.sourceRef ?? '').startsWith('apiFile:'),
    );
    response.status(200).json(successResponse({ list, isImported }, requestId));
  },
  { validationErrorCode: 501017 },
);
