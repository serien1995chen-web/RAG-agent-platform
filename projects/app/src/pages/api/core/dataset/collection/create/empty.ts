import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';

interface CollectionCreateEmptyBody {
  datasetId: string;
  parentId?: string;
  name: string;
  type?: 'virtual' | 'file';
}

/** API-COL-017 POST /api/core/dataset/collection/create/empty（无 ParsingJob） */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateEmptyBody>('CollectionCreateEmptyBody', request.body);
    const type = body.type ?? 'virtual';
    const created = await runtime.collectionRepository.create(
      {
        collection: {
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          parentId: body.parentId ?? null,
          type,
          name: body.name,
          tagIds: [],
          trainingPolicy: null,
        },
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    response
      .status(200)
      .json(successResponse({ collectionId: created.collectionId, type }, requestId));
  },
  { validationErrorCode: 501004 },
);
