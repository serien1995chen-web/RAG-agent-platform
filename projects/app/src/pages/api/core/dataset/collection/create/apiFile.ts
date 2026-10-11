import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../../runtime';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import {
  PORT_OPTIONS,
  apiError,
  createImportSourceService,
  resolveSourceProvider,
  sourceCollection,
} from '../../../../../../shared/import-source';

interface CollectionCreateApiFileBody {
  datasetId: string;
  apiConfig: unknown;
  path: string;
}

/** API-COL-007 POST /api/core/dataset/collection/create/apiFile */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateApiFileBody>(
      'CollectionCreateApiFileBody',
      request.body,
    );
    let provider;
    try {
      provider = resolveSourceProvider('apiFile');
    } catch {
      throw apiError(501017, requestId, { provider: 'apiFile' });
    }
    const sourceRef = JSON.stringify({ config: body.apiConfig, path: body.path });
    const service = createImportSourceService(runtime, provider);
    const result = await service.createCollectionFromSource(
      {
        collection: sourceCollection({
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          name: body.path,
          sourceRef,
        }),
        sourceType: 'apiFile',
        sourceRef,
        options: PORT_OPTIONS,
      },
      context,
    );
    response.status(200).json(successResponse({ collectionId: result.collectionId }, requestId));
  },
  { validationErrorCode: 501039 },
);