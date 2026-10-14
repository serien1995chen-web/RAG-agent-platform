import { ApiErrorException, createApiError } from '@kb/contracts';
import type { DeleteJobSnapshot } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../../runtime';
import { authenticateRequest } from '../../../../../../runtime/auth';
import {
  parseDto,
  readIdempotencyKey,
  successResponse,
  withApiHandler,
} from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';

interface DeleteRetryBody {
  jobId: string;
  'Idempotency-Key': string;
}

const OWNER_PERMISSION = 8;

function retryDenied(requestId: string, jobId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501024,
      requestId,
      params: { jobId, permission: 'owner' },
    }),
  );
}

/** API-DEL-003 POST /api/core/dataset/delete-jobs/{jobId}/retry */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const headerIdempotencyKey = readIdempotencyKey(request);
    const rawBody =
      typeof request.body === 'object' && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};
    const pathJobId = Array.isArray(request.query.jobId)
      ? request.query.jobId[0]
      : request.query.jobId;
    const body = parseDto<DeleteRetryBody>('DeleteRetryBody', {
      ...rawBody,
      ...(pathJobId !== undefined ? { jobId: pathJobId } : {}),
      ...(headerIdempotencyKey !== null ? { 'Idempotency-Key': headerIdempotencyKey } : {}),
    });
    const options = { timeoutMs: 5_000 };
    let job: DeleteJobSnapshot;
    try {
      job = await runtime.deleteService.getDeleteJob({ jobId: body.jobId, options }, context);
    } catch (error) {
      if (error instanceof ApiErrorException && error.error.code === 501070) {
        throw retryDenied(requestId, body.jobId);
      }
      throw error;
    }
    const permission = await runtime.datasetPermission.getPermission(
      { datasetId: job.datasetId, options },
      context,
    );
    if (!context.tenant.isRoot && (permission.permissionMask & OWNER_PERMISSION) === 0) {
      throw retryDenied(requestId, body.jobId);
    }
    await runtime.deleteService.retryDeleteJob({ jobId: body.jobId, options }, context);
    response.status(200).json(successResponse({ accepted: true }, requestId));
  },
  { validationErrorCode: 501024 },
);
