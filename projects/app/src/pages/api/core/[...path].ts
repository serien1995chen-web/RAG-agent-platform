import { ApiErrorException, createSkeletonError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { matchRoute, withApiHandler } from '../../../shared/api';
import type { ApiHandlerContext } from '../../../shared/api';

/** /api/core/** 未实现路由：稳定 501999，禁止 200 空对象。 */
export default withApiHandler(
  async (request: NextApiRequest, _response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const route = matchRoute(request.method, request.url);
    throw new ApiErrorException(
      createSkeletonError(
        route
          ? { route: route.routeId }
          : { operation: `unmatched:${request.method ?? 'GET'} ${request.url ?? ''}` },
        requestId,
      ),
    );
  },
);
