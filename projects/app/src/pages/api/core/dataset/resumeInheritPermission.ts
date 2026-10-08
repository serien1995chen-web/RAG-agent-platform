import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

/** API-ACL-002 POST /api/core/dataset/resumeInheritPermission */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<{ datasetId: string; version: number }>(
      'ResumeInheritPermissionBody',
      request.body,
    );
    const snapshot = await runtime.datasetPermission.resumeInherit(
      {
        datasetId: body.datasetId,
        version: body.version,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    response
      .status(200)
      .json(successResponse({ permissionMask: snapshot.permissionMask }, requestId));
  },
  { validationErrorCode: 501008 },
);
