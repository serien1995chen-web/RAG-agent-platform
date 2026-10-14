import { createHash } from 'node:crypto';
import { ApiErrorException, createApiError, getErrorMeta } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../../runtime';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';

interface DeleteFailuresQuery {
  jobId: string;
  cursor?: string;
  limit?: number;
}

const OWNER_PERMISSION = 8;

function resourceIdHash(resourceId: string): string {
  return createHash('sha256').update(resourceId).digest('hex');
}

function safeFailureReason(reason: string): string {
  const match = /^(\d{6})\s+([a-z0-9_.:-]+)$/i.exec(reason.trim());
  if (!match?.[1] || !match[2]) return 'dataset.delete.failed';
  const code = Number(match[1]);
  const meta = getErrorMeta(code);
  if (!meta || meta.messageKey !== match[2]) return 'dataset.delete.failed';
  return `${match[1]} ${match[2]}`;
}

/** API-DEL-002 GET /api/core/dataset/delete-jobs/{jobId}/failures */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<DeleteFailuresQuery>('DeleteFailuresQuery', request.query);
    const options = { timeoutMs: 5_000 };
    const job = await runtime.deleteService.getDeleteJob({ jobId: query.jobId, options }, context);
    const permission = await runtime.datasetPermission.getPermission(
      { datasetId: job.datasetId, options },
      context,
    );
    if (!context.tenant.isRoot && (permission.permissionMask & OWNER_PERMISSION) === 0) {
      throw new ApiErrorException(
        createApiError({
          code: 501027,
          requestId,
          params: { jobId: query.jobId, permission: 'owner' },
        }),
      );
    }
    const failures = await runtime.deleteService.listFailures(
      {
        jobId: query.jobId,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
        limit: query.limit ?? 20,
        options,
      },
      context,
    );
    response.status(200).json(
      successResponse(
        {
          total: failures.total,
          list: failures.list.map((failure) => ({
            resourceType: failure.resourceType,
            resourceIdHash: resourceIdHash(failure.resourceId),
            reason: safeFailureReason(failure.reason),
          })),
          cursor: failures.cursor,
        },
        requestId,
      ),
    );
  },
  { validationErrorCode: 501027 },
);
