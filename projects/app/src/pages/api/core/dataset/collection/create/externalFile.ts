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

interface CollectionCreateExternalFileBody {
  datasetId: string;
  provider: string;
  fileKey: string;
}

/** API-COL-006 POST /api/core/dataset/collection/create/externalFile */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateExternalFileBody>(
      'CollectionCreateExternalFileBody',
      request.body,
    );
    let provider;
    try {
      provider = resolveSourceProvider('externalFile');
    } catch {
      throw apiError(501017, requestId, { provider: body.provider });
    }
    const service = createImportSourceService(runtime, provider);
    const result = await service.createCollectionFromSource(
      {
        collection: sourceCollection({
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          name: body.fileKey,
          sourceRef: body.fileKey,
        }),
        sourceType: 'externalFile',
        sourceRef: body.fileKey,
        options: PORT_OPTIONS,
      },
      context,
    );
    response.status(200).json(successResponse({ collectionId: result.collectionId }, requestId));
  },
  { validationErrorCode: 501019 },
);
