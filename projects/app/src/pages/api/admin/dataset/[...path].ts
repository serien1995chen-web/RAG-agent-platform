import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../runtime';
import { successResponse, withAdminHandler } from '../../../../shared/api';
import type { AdminHandlerContext } from '../../../../shared/api';

function pathOf(request: NextApiRequest): string {
  const value = request.query.path;
  if (Array.isArray(value)) return value.join('/');
  return typeof value === 'string' ? value : '';
}

function notFound(requestId: string, path: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501070,
      requestId,
      params: { resourceType: 'admin_dataset_path', resourceId: path },
    }),
  );
}

/** /api/admin/dataset/** Root Admin whitelist: health/system only. */
export default withAdminHandler(
  async (request: NextApiRequest, response: NextApiResponse, admin: AdminHandlerContext) => {
    const path = pathOf(request);
    const runtime = await getRuntime();
    if (path === 'health' && (request.method ?? 'GET').toUpperCase() === 'GET') {
      const required = await runtime.health.checkRequired(admin.context);
      const optional = await runtime.health.checkOptional(admin.context);
      const summary = runtime.health.summarize(required, optional);
      response.status(summary.httpStatus).json(successResponse(summary.response, admin.requestId));
      return;
    }
    if (path === 'system' && (request.method ?? 'GET').toUpperCase() === 'GET') {
      response.status(200).json(
        successResponse(
          {
            instanceId: runtime.config.system.instanceId,
            role: runtime.config.role,
            startup: runtime.startup,
            startedAt: runtime.startedAt,
          },
          admin.requestId,
        ),
      );
      return;
    }
    throw notFound(admin.requestId, path);
  },
);
