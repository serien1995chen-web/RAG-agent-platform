import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { isDeleteJobVisibleTo } from '../../../../../shared/api/delete-job-auth';

interface DeleteJobQuery {
  jobId: string;
}

/** API-DEL-001 GET /api/core/dataset/delete-jobs/{jobId} */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<DeleteJobQuery>('DeleteJobQuery', request.query);
    const options = { timeoutMs: 5_000 };
    const job = await runtime.deleteService.getDeleteJob({ jobId: query.jobId, options }, context);
    // DEMO-001：Dataset 已软删除，不能再依赖 Dataset ACL；按任务归属鉴权。
    if (!isDeleteJobVisibleTo(job, context)) {
      throw new ApiErrorException(
        createApiError({
          code: 501027,
          requestId,
          params: { jobId: query.jobId, permission: 'owner' },
        }),
      );
    }
    response.status(200).json(
      successResponse(
        {
          state: job.state,
          stage: job.stage,
          progress: job.progress,
        },
        requestId,
      ),
    );
  },
  { validationErrorCode: 501027 },
);
