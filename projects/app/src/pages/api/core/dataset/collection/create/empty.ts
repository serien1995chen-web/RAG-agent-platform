import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../../runtime';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import { PORT_OPTIONS, apiError, sourceCollection } from '../../../../../../shared/import-source';

interface CollectionCreateEmptyBody {
  datasetId: string;
  parentId?: string;
  name: string;
  type?: 'virtual' | 'file';
}

/** API-COL-017 POST /api/core/dataset/collection/create/empty */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateEmptyBody>('CollectionCreateEmptyBody', request.body);
    if (body.name.length < 1 || body.name.length > 100) {
      throw apiError(501004, requestId, { field: 'name' });
    }
    const type = body.type ?? 'virtual';
    const created = await runtime.collectionRepository.create(
      {
        collection: sourceCollection({
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          parentId: body.parentId ?? null,
          name: body.name,
          type,
          sourceRef: type === 'virtual' ? 'virtual' : 'empty',
        }),
        options: PORT_OPTIONS,
      },
      context,
    );
    response
      .status(200)
      .json(successResponse({ collectionId: created.collectionId, type }, requestId));
  },
  { validationErrorCode: 501004 },
);