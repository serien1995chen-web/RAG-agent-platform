import { randomBytes } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import { InsertDataService } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { readMultipartForm } from '../file/presignUpload';

interface ImportFormFields {
  file: Uint8Array;
  datasetId: string;
  targetCollectionId?: string;
}

function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(filename);
  return (match?.[1] ?? '').toLowerCase();
}

function rowsOf(bytes: Uint8Array, filename: string): { q: string; a: string }[] {
  const extension = extensionOf(filename);
  if (extension === 'jsonl') {
    return Buffer.from(bytes)
      .toString('utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const parsed = JSON.parse(line) as { q?: string; a?: string };
        return { q: parsed.q ?? '', a: parsed.a ?? '' };
      });
  }
  return [];
}

/** API-IMP-001 POST /api/core/dataset/collection/import */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const form = readMultipartForm(request);
    const filePart = form.files.file;
    if (!filePart || filePart.content.byteLength === 0) {
      throw new ApiErrorException(
        createApiError({
          code: 501059,
          requestId,
          params: { sheetName: '', reason: 'missing_file', limit: 1 },
        }),
      );
    }
    const fields = parseDto<ImportFormFields>('DatasetImportForm', {
      file: filePart.content,
      datasetId: form.fields.datasetId,
      ...(form.fields.targetCollectionId !== undefined
        ? { targetCollectionId: form.fields.targetCollectionId }
        : {}),
    });
    const options = { timeoutMs: 60_000 };
    let collectionId = fields.targetCollectionId ?? '';
    if (!collectionId) {
      const created = await runtime.collectionRepository.create(
        {
          collection: {
            teamId: context.tenant.teamId,
            datasetId: fields.datasetId,
            parentId: null,
            type: 'import',
            name: filePart.filename || 'import',
            tagIds: [],
            trainingPolicy: null,
          },
          options,
        },
        context,
      );
      collectionId = created.collectionId;
    }
    const service = new InsertDataService({
      items: runtime.knowledgeItemRepository,
      vectors: runtime.vectorController,
      fullText: runtime.fullTextStore ?? runtime.ports.fullTextStore,
    });
    const report = { success: 0, skipped: 0, failed: 0, errors: [] as unknown[] };
    const rows = rowsOf(filePart.content, filePart.filename);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row) continue;
      try {
        const vectors = await runtime.embeddingService.embed(
          { models: { embeddingModel: 'bge-m3' }, texts: [row.q], options },
          context,
        );
        const result = await service.insertDirect(
          {
            dataId: randomBytes(12).toString('hex'),
            datasetId: fields.datasetId,
            collectionId,
            q: row.q,
            ...(row.a ? { a: row.a } : {}),
            vector: vectors[0] ?? [],
            options,
          },
          context,
        );
        if (result.duplicates > 0) report.skipped += 1;
        else report.success += 1;
      } catch (error) {
        report.failed += 1;
        report.errors.push({
          row: index,
          code: String((error as { error?: { code?: number } }).error?.code ?? 'import_failed'),
          messageKey: 'dataset.import.row_failed',
          params: {},
        });
      }
    }
    response.status(200).json(successResponse({ report }, requestId));
  },
  { validationErrorCode: 501058 },
);
