import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../../runtime';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import {
  PORT_OPTIONS,
  createImportSourceService,
  resolveSourceProvider,
  sourceCollection,
} from '../../../../../../shared/import-source';

interface CollectionCreateTextBody {
  datasetId: string;
  text: string;
}

/** API-COL-005 POST /api/core/dataset/collection/create/text */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateTextBody>('CollectionCreateTextBody', request.body);
    const service = createImportSourceService(runtime, resolveSourceProvider('text'));
    const result = await service.createCollectionFromSource(
      {
        collection: sourceCollection({
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          name: 'text',
          sourceRef: body.text,
        }),
        sourceType: 'text',
        sourceRef: body.text,
        options: PORT_OPTIONS,
      },
      context,
    );
    response
      .status(200)
      .json(
        successResponse(
          { collectionId: result.collectionId, insertLen: result.insertLen },
          requestId,
        ),
      );
  },
  { validationErrorCode: 501030 },
);
