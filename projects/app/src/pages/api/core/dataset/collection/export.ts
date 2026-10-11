import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { apiError } from '../../../../../shared/import-source';

interface CollectionExportQuery {
  collectionId: string;
  format?: 'jsonl';
}

/** API-EXP-002 GET /api/core/dataset/collection/export */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<CollectionExportQuery>('CollectionExportQuery', request.query);
    const collection = await runtime.collectionService.getCollection(
      { collectionId: query.collectionId, options: { timeoutMs: 10_000 } },
      context,
    );
    if (collection.teamId !== context.tenant.teamId) {
      throw apiError(501027, requestId, { requiredRole: 'read' });
    }
    const items = await runtime.knowledgeItemService.listItems(
      { collectionId: query.collectionId, page: 1, limit: 1000, options: { timeoutMs: 10_000 } },
      context,
    );
    const jsonl = items.list
      .map((item) => JSON.stringify({ dataId: item.dataId, q: item.q, a: item.a ?? '' }))
      .join('\n');
    response.status(200).json(
      successResponse(
        {
          contentType: 'application/x-ndjson',
          body: Buffer.from(jsonl, 'utf8').toString('base64'),
        },
        requestId,
      ),
    );
  },
  { validationErrorCode: 501070 },
);