import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { matchRoute, withApiHandler } from '../../../shared/api';
import type { ApiHandlerContext } from '../../../shared/api';

/**
 * 扩展 API 统一入口（实际路径 /api/proApi/**，SKEL-ADR-006）。
 * 扩展未启用时返回稳定错误 501020，核心 Dataset 路由不受影响。
 */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const registryUrl = (request.url ?? '').replace(/^\/api/, '');
    const route = matchRoute(request.method, registryUrl);
    throw new ApiErrorException(
      createApiError({
        code: 501020,
        requestId,
        params: { extension: route?.routeId ?? 'proApi' },
      }),
    );
  },
);
