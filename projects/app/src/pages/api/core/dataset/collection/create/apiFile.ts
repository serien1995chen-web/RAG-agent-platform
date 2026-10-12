import type { DatasetSourceProvider } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import { buildImportSource } from './file';

interface CollectionCreateApiFileBody {
  datasetId: string;
  apiConfig: unknown;
  path: string;
}

/** API-COL-007 POST /api/core/dataset/collection/create/apiFile */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateApiFileBody>('CollectionCreateApiFileBody', request.body);
    const base = runtime.datasetSourceProvider;
    // 请求级 provider 包装：仅注入本次调用的 apiConfig，不复制 Provider 逻辑。
    const provider: DatasetSourceProvider = {
      read: (sourceRequest, sourceContext) =>
        base.read({ ...sourceRequest, apiConfig: body.apiConfig as never }, sourceContext),
      preview: (sourceRequest, sourceContext) =>
        base.preview({ ...sourceRequest, apiConfig: body.apiConfig as never }, sourceContext),
    };
    const service = buildImportSource(runtime, provider);
    const result = await service.createCollectionFromSource(
      {
        collection: {
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          parentId: null,
          type: 'apiFile',
          name: body.path,
          tagIds: [],
          sourceRef: body.path,
          trainingPolicy: null,
        },
        sourceType: 'apiFile',
        sourceRef: body.path,
        options: { timeoutMs: 60_000 },
      },
      context,
    );
    response.status(200).json(successResponse({ collectionId: result.collectionId }, requestId));
  },
  { validationErrorCode: 501017 },
);
