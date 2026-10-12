import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface ApiDatasetExistIdQuery {
  datasetId: string;
  apiConfigId: string;
}

/** API-APIDS-004 GET /api/core/dataset/apiDataset/listExistId（不触发 Provider 网络请求） */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<ApiDatasetExistIdQuery>('ApiDatasetExistIdQuery', request.query);
    const prefix = `apiFile:${query.apiConfigId}:`;
    const fileIds: string[] = [];
    let page = 1;
    for (;;) {
      const result = await runtime.collectionRepository.list(
        { datasetId: query.datasetId, page, limit: 100, options: { timeoutMs: 5_000 } },
        context,
      );
      for (const collection of result.list) {
        const sourceRef = collection.sourceRef ?? '';
        if (sourceRef.startsWith(prefix)) fileIds.push(sourceRef.slice(prefix.length));
      }
      if (!result.cursor || result.list.length === 0) break;
      page += 1;
    }
    response.status(200).json(successResponse({ fileIds }, requestId));
  },
  { validationErrorCode: 501061 },
);
