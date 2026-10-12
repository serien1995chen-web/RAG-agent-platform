import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface CollectionExportQuery {
  collectionId: string;
  format?: 'jsonl';
}

/** API-EXP-002 GET /api/core/dataset/collection/export */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<CollectionExportQuery>('CollectionExportQuery', request.query);
    const items = await runtime.knowledgeItemService.listItems(
      { collectionId: query.collectionId, page: 1, limit: 1000, options: { timeoutMs: 5_000 } },
      context,
    );
    const jsonl =
      items.list.length > 0
        ? items.list
            .map((item) =>
              JSON.stringify({
                collectionId: item.collectionId,
                dataId: item.dataId,
                q: item.q ?? '',
                a: item.a ?? '',
                indexes: (item.indexes ?? []).map((index) => ({
                  indexId: index.indexId,
                  type: index.type,
                  text: index.text,
                })),
                metadata: item.metadata ?? null,
              }),
            )
            .join('\n') + '\n'
        : '';
    response.status(200);
    response.setHeader('content-type', 'application/x-ndjson');
    response.send(jsonl);
  },
  { validationErrorCode: 501070 },
);
