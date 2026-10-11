import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { apiError } from '../../../../../shared/import-source';

interface ApiDatasetCatalogBody {
  datasetId: string;
  apiConfig: unknown;
  parentId?: string;
}

interface ApiDatasetClient {
  getCatalog(input: {
    datasetId: string;
    apiConfig: unknown;
    parentId?: string;
  }): Promise<unknown[]>;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; nodes: unknown[] }>();

/** API-APIDS-001 POST /api/core/dataset/apiDataset/getCatalog */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<ApiDatasetCatalogBody>('ApiDatasetCatalogBody', request.body);
    const client = (runtime.ports as { apiDatasetClient?: ApiDatasetClient }).apiDatasetClient;
    if (!client) throw apiError(501017, requestId, { provider: 'apiDataset' });
    const key = JSON.stringify([context.tenant.teamId, body.datasetId, body.parentId ?? null]);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      response.status(200).json(successResponse({ nodes: cached.nodes }, requestId));
      return;
    }
    try {
      const nodes = await client.getCatalog({
        datasetId: body.datasetId,
        apiConfig: body.apiConfig,
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
      });
      cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, nodes });
      response.status(200).json(successResponse({ nodes }, requestId));
    } catch {
      throw apiError(501039, requestId, { provider: 'apiDataset' });
    }
  },
  { validationErrorCode: 501039 },
);
