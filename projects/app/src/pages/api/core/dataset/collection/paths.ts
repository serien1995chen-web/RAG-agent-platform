import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

/** API-PATH-002 GET /api/core/dataset/collection/paths */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<{ sourceId: string; datasetId: string }>(
      'CollectionPathsQuery',
      request.query,
    );
    const paths = await runtime.collectionService.listPaths(
      {
        datasetId: query.datasetId,
        sourceId: query.sourceId,
        type: 'collection',
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    response.status(200).json(successResponse(paths, requestId));
  },
  { validationErrorCode: 501070 },
);
