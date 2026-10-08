import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';

interface CollectionCreateFolderBody {
  datasetId: string;
  parentId?: string;
  name: string;
}

/** API-COL-002 POST /api/core/dataset/collection/create/folder */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateFolderBody>('CollectionCreateFolderBody', request.body);
    const created = await runtime.collectionRepository.create(
      {
        collection: {
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          parentId: body.parentId ?? null,
          type: 'folder',
          name: body.name,
          tagIds: [],
        },
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    response.status(200).json(successResponse({ collectionId: created.collectionId }, requestId));
  },
  { validationErrorCode: 501004 },
);
