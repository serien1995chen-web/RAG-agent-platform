import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

const PORT_OPTIONS = { timeoutMs: 10_000 } as const;
function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

interface VirtualCollectionQuery {
  collectionId: string;
}

/** API-VIRT-001 GET /api/core/dataset/collection/virtual */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<VirtualCollectionQuery>('VirtualCollectionQuery', request.query);
    const collection = await runtime.collectionService.getCollection(
      { collectionId: query.collectionId, options: PORT_OPTIONS },
      context,
    );
    if (collection.teamId !== context.tenant.teamId) {
      throw apiError(501027, requestId, { requiredRole: 'read' });
    }
    response
      .status(200)
      .json(
        successResponse(
          { virtual: collection.type === 'virtual', sourceRef: collection.sourceRef ?? '' },
          requestId,
        ),
      );
  },
  { validationErrorCode: 501070 },
);
