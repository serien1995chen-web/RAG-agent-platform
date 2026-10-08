import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

/** API-PATH-004 POST /api/core/dataset/collection/move */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<{ collectionId: string; targetParentId?: string; version: number }>(
      'CollectionMoveBody',
      request.body,
    );
    const updated = await runtime.collectionService.moveCollection(
      {
        collectionId: body.collectionId,
        version: body.version,
        targetParentId: body.targetParentId ?? null,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    response.status(200).json(successResponse(updated, requestId));
  },
  { validationErrorCode: 501046 },
);
