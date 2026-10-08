import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

/** API-ACL-001 GET /api/core/dataset/getPermission */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<{ datasetId: string }>('DatasetDetailQuery', request.query);
    const snapshot = await runtime.datasetPermission.getPermission(
      { datasetId: query.datasetId, options: { timeoutMs: 5_000 } },
      context,
    );
    response.status(200).json(
      successResponse(
        {
          permissionMask: snapshot.permissionMask,
          inheritEnabled: snapshot.inherited,
          source: snapshot.source,
        },
        requestId,
      ),
    );
  },
  { validationErrorCode: 501070 },
);
