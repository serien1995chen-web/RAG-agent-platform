import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../runtime';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';
import { apiError } from '../../../../shared/import-source';

interface DatasetExportQuery {
  datasetId: string;
  format?: 'jsonl' | 'zip';
}

interface ExportRow {
  collectionId: string;
  dataId: string;
  q: string;
  a?: string;
}

function toJsonl(rows: ExportRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

/** API-EXP-001 GET /api/core/dataset/exportAll */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<DatasetExportQuery>('DatasetExportQuery', request.query);
    const detail = await runtime.datasetApi.getDatasetDetail(query.datasetId, context);
    if (detail.dataset.teamId !== context.tenant.teamId) {
      throw apiError(501027, requestId, { requiredRole: 'read' });
    }
    const collections = await runtime.collectionRepository.list(
      { datasetId: query.datasetId, page: 1, limit: 1000, options: { timeoutMs: 10_000 } },
      context,
    );
    const rows: ExportRow[] = [];
    for (const collection of collections.list) {
      const items = await runtime.knowledgeItemService.listItems(
        { collectionId: collection.collectionId, page: 1, limit: 1000, options: { timeoutMs: 10_000 } },
        context,
      );
      for (const item of items.list) {
        rows.push({
          collectionId: collection.collectionId,
          dataId: item.dataId,
          q: item.q ?? '',
          ...(item.a !== undefined ? { a: item.a } : {}),
        });
      }
    }
    const jsonl = toJsonl(rows);
    const format = query.format ?? 'zip';
    const payload = Buffer.from(jsonl, 'utf8').toString('base64');
    response.status(200).json(
      successResponse(
        {
          contentType: format === 'zip' ? 'application/zip' : 'application/x-ndjson',
          body: payload,
        },
        requestId,
      ),
    );
  },
  { validationErrorCode: 501070 },
);
