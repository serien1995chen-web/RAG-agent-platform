import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import { buildImportSource } from './file';

interface CollectionCreateExternalFileBody {
  datasetId: string;
  provider: string;
  fileKey: string;
  config?: unknown;
}

/** API-COL-006 POST /api/core/dataset/collection/create/externalFile */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateExternalFileBody>(
      'CollectionCreateExternalFileBody',
      request.body,
    );
    const service = buildImportSource(runtime);
    const result = await service.createCollectionFromSource(
      {
        collection: {
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          parentId: null,
          type: 'externalFile',
          name: body.fileKey,
          tagIds: [],
          sourceRef: body.fileKey,
          trainingPolicy: null,
        },
        sourceType: 'externalFile',
        sourceRef: body.fileKey,
        options: { timeoutMs: 60_000 },
      },
      context,
    );
    response.status(200).json(successResponse({ collectionId: result.collectionId }, requestId));
  },
  { validationErrorCode: 501017 },
);
