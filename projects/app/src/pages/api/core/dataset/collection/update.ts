import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface CollectionUpdateBody {
  collectionId: string;
  version: number;
  parentId?: string;
  name?: string;
  tagIds?: string[];
}

/** API-COL-012 POST /api/core/dataset/collection/update */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionUpdateBody>('CollectionUpdateBody', request.body);
    const updated = await runtime.collectionRepository.update(
      {
        collectionId: body.collectionId,
        version: body.version,
        patch: {
          ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.tagIds !== undefined ? { tagIds: body.tagIds } : {}),
        },
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    response.status(200).json(successResponse(updated, requestId));
  },
  { validationErrorCode: 501004 },
);
