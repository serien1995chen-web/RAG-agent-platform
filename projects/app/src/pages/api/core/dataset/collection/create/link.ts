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

interface CollectionCreateLinkBody {
  datasetId: string;
  link: string;
  selector?: string;
}

/** API-COL-004 POST /api/core/dataset/collection/create/link */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateLinkBody>('CollectionCreateLinkBody', request.body);
    let provider;
    try {
      provider = resolveSourceProvider('link');
    } catch {
      throw apiError(501017, requestId, { provider: 'link' });
    }
    const service = createImportSourceService(runtime, provider);
    const result = await service.createCollectionFromSource(
      {
        collection: sourceCollection({
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          name: body.link,
          sourceRef: body.link,
        }),
        sourceType: 'link',
        sourceRef: body.link,
        options: PORT_OPTIONS,
      },
      context,
    );
    response
      .status(200)
      .json(
        successResponse({ collectionId: result.collectionId, state: result.status }, requestId),
      );
  },
  { validationErrorCode: 501065 },
);
