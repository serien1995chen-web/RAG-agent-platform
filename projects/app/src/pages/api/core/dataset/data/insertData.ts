import { createHash } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import { InsertDataService } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

const PORT_OPTIONS = { timeoutMs: 10_000 } as const;
function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

interface InsertDataBody {
  collectionId: string;
  q: string;
  a?: string;
  imageId?: string;
}

function stableDataId(collectionId: string, q: string, a: string): string {
  const digest = createHash('sha256').update(`${collectionId}\u0000${q}\u0000${a}`).digest('hex');
  // Mongoose dataId 为 ObjectId：必须是 24 位十六进制。
  return digest.slice(0, 24);
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
    const dataId = stableDataId(body.collectionId, body.q, body.a ?? '');
    const text = body.a && body.a.length > 0 ? `${body.q}\n${body.a}` : body.q;
    const vector = await runtime.modelRuntime.embedText({ text, options: PORT_OPTIONS }, context);
    const result = await service.insertDirect(
      {
        dataId,
        datasetId: collection.datasetId,
        collectionId: body.collectionId,
        q: body.q,
        ...(body.a !== undefined ? { a: body.a } : {}),
        indexType: 'question',
        vector,
        options: PORT_OPTIONS,
      },
      context,
    );
    response.status(200).json(successResponse({ dataId: result.dataId }, requestId));
  },
  { validationErrorCode: 501003 },
);
