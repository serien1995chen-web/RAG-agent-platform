import { InsertDataService } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { PORT_OPTIONS, apiError } from '../../../../../shared/import-source';

interface InsertDataBody {
  collectionId: string;
  q: string;
  a?: string;
  imageId?: string;
}

function newDataId(): string {
  return `data-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** API-DATA-005 POST /api/core/dataset/data/insertData */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<InsertDataBody>('InsertDataBody', request.body);
    if (body.imageId !== undefined && (!body.q || body.q.trim().length === 0)) {
      throw apiError(501038, requestId, { route: 'insertData' });
    }
    if (!body.q || body.q.trim().length === 0) {
      throw apiError(501003, requestId, { dataId: '' });
    }
    const collection = await runtime.collectionService.getCollection(
      { collectionId: body.collectionId, options: PORT_OPTIONS },
      context,
    );
    const service = new InsertDataService({
      items: runtime.knowledgeItemRepository,
      vectors: runtime.ports.vectorController,
      fullText: runtime.ports.fullTextStore,
    });
    const dataId = newDataId();
    const result = await service.insertDirect(
      {
        dataId,
        datasetId: collection.datasetId,
        collectionId: body.collectionId,
        q: body.q,
        ...(body.a !== undefined ? { a: body.a } : {}),
        vector: [],
        options: PORT_OPTIONS,
      },
      context,
    );
    response.status(200).json(successResponse({ dataId: result.dataId }, requestId));
  },
  { validationErrorCode: 501003 },
);
