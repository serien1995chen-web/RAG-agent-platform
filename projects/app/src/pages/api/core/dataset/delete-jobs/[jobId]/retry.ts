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
import { isDeleteJobVisibleTo } from '../../../../../../shared/api/delete-job-auth';

interface DeleteRetryBody {
  jobId: string;
  'Idempotency-Key': string;
}

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
    // DEMO-001：Dataset 已软删除，按任务归属鉴权（见 delete-job-auth）。
    if (!isDeleteJobVisibleTo(job, context)) {
      throw retryDenied(requestId, body.jobId);
    }
    await runtime.deleteService.retryDeleteJob({ jobId: body.jobId, options }, context);
    response.status(200).json(successResponse({ accepted: true }, requestId));
  },
  { validationErrorCode: 501024 },
);
