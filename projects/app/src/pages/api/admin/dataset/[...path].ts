import { ApiErrorException, createSkeletonError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { matchRoute, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

/** /api/admin/dataset/** Root Admin 路由骨架：Phase 5 全部返回稳定未实现错误。 */
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
