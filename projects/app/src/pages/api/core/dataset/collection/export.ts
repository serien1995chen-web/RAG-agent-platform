import type { RequestContext } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface CollectionExportQuery {
  collectionId: string;
  format?: 'jsonl';
}

const ITEM_PAGE_SIZE = 200;
const OPTIONS = { timeoutMs: 5_000 };

function lineOf(item: {
  collectionId: string;
  dataId: string;
  q?: string;
  a?: string;
  indexes?: { indexId: string; type: string; text: string }[];
  metadata?: unknown;
}): string {
  return (
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
    }) + '\n'
  );
}

/** API-EXP-002 GET /api/core/dataset/collection/export（按 page 完整遍历并流式输出） */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime: ExtendedAppRuntime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<CollectionExportQuery>('CollectionExportQuery', request.query);
    response.status(200);
    response.setHeader('content-type', 'application/x-ndjson');
    await streamCollection(response, runtime, query.collectionId, context);
    response.end();
  },
  { validationErrorCode: 501070 },
);

async function streamCollection(
  response: NextApiResponse,
  runtime: ExtendedAppRuntime,
  collectionId: string,
  context: RequestContext,
): Promise<void> {
  for (let page = 1; ; page += 1) {
    const items = await runtime.knowledgeItemService.listItems(
      { collectionId, page, limit: ITEM_PAGE_SIZE, options: OPTIONS },
      context,
    );
    if (items.list.length === 0) return;
    for (const item of items.list) response.write(lineOf(item));
    if (items.list.length < ITEM_PAGE_SIZE) return;
  }
}
