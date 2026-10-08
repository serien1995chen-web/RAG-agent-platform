import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

/** API-PATH-001 GET /api/core/dataset/paths */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<{ sourceId: string; type: 'dataset' | 'folder' }>(
      'DatasetPathsQuery',
      request.query,
    );
    const dataset = await runtime.knowledgeBaseRepository.findByDatasetId(
      { datasetId: query.sourceId },
      context,
    );
    if (!dataset) {
      response.status(200).json(successResponse([], requestId));
      return;
    }
    response
      .status(200)
      .json(
        successResponse(
          [{ id: dataset.datasetId, name: dataset.name, parentId: dataset.parentId }],
          requestId,
        ),
      );
  },
  { validationErrorCode: 501070 },
);
