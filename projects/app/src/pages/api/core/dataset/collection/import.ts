import { randomBytes } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import { createDefaultDocumentParser, type DocumentParseContext } from '@kb/parse';
import { InsertDataService } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { readMultipartForm } from '../file/presignUpload';

// multipart/form-data 需自行读取原始流；导入允许至多 20MB。
export const config = { api: { bodyParser: false } };

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_ROWS = 10000;

interface MappingColumn {
  sourceColumn: string;
  targetField: string;
  required?: boolean;
}

interface ImportMappingValue {
  sourceFormat?: string;
  columns?: MappingColumn[];
}

interface ImportFormFields {
  file: Uint8Array;
  datasetId: string;
  targetCollectionId?: string;
  mapping?: ImportMappingValue;
}

interface ExtractedRow {
  q: string;
  a: string;
  error?: string;
}

function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(filename);
  return (match?.[1] ?? '').toLowerCase();
}

function fail(code: number, requestId: string, params: Record<string, unknown>): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

function headerInvalid(
  requestId: string,
  missingHeaders: string[],
  duplicateHeaders: string[],
): ApiErrorException {
  return fail(501058, requestId, { missingHeaders, duplicateHeaders });
}

function sheetInvalid(requestId: string, reason: string): ApiErrorException {
  return fail(501059, requestId, { sheetName: '', reason, limit: MAX_IMPORT_ROWS });
}

function parseMapping(raw: string | undefined, requestId: string): ImportMappingValue | undefined {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as ImportMappingValue;
  } catch {
    throw headerInvalid(requestId, [], []);
  }
}

function cellsOf(line: string): string[] {
  return line
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function parseMarkdownTable(text: string): { header: string[]; rows: string[][] } {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'));
  if (lines.length === 0) return { header: [], rows: [] };
  const header = cellsOf(lines[0] ?? '');
  const rows: string[][] = [];
  for (const line of lines.slice(1)) {
    if (/^\|[\s\-:|]+\|$/.test(line)) continue;
    rows.push(cellsOf(line));
  }
  return { header, rows };
}

function resolveColumns(
  header: string[],
  mapping: ImportMappingValue | undefined,
  requestId: string,
): { qIndex: number; aIndex: number } {
  const normalized = header.map((name) => name.toLowerCase());
  const seen = new Set<string>();
  const duplicateHeaders: string[] = [];
  for (const name of normalized) {
    if (name.length === 0) continue;
    if (seen.has(name)) {
      if (!duplicateHeaders.includes(name)) duplicateHeaders.push(name);
    } else {
      seen.add(name);
    }
  }
  if (duplicateHeaders.length > 0) throw headerInvalid(requestId, [], duplicateHeaders);
  if (mapping?.columns && mapping.columns.length > 0) {
    const missingHeaders = mapping.columns
      .filter((column) => column.required)
      .map((column) => column.sourceColumn)
      .filter((name) => !normalized.includes(name.toLowerCase()));
    if (missingHeaders.length > 0) throw headerInvalid(requestId, missingHeaders, []);
    const qColumn = mapping.columns.find((column) => column.targetField === 'q');
    const aColumn = mapping.columns.find((column) => column.targetField === 'a');
    const qIndex = qColumn ? normalized.indexOf(qColumn.sourceColumn.toLowerCase()) : -1;
    const aIndex = aColumn ? normalized.indexOf(aColumn.sourceColumn.toLowerCase()) : -1;
    if (qIndex < 0) throw headerInvalid(requestId, ['q'], []);
    return { qIndex, aIndex };
  }
  const qIndex = normalized.indexOf('q');
  const aIndex = normalized.indexOf('a');
  const missingHeaders: string[] = [];
  if (qIndex < 0) missingHeaders.push('q');
  if (aIndex < 0) missingHeaders.push('a');
  if (missingHeaders.length > 0) throw headerInvalid(requestId, missingHeaders, []);
  return { qIndex, aIndex };
}

async function extractRows(input: {
  bytes: Uint8Array;
  filename: string;
  datasetId: string;
  teamId: string;
  mapping?: ImportMappingValue;
  requestId: string;
}): Promise<ExtractedRow[]> {
  const extension = extensionOf(input.filename);
  if (extension === 'jsonl') {
    return Buffer.from(input.bytes)
      .toString('utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as { q?: string; a?: string };
          return { q: parsed.q ?? '', a: parsed.a ?? '' };
        } catch {
          return { q: '', a: '', error: 'json_parse_failed' };
        }
      });
  }
  if (extension !== 'csv' && extension !== 'xlsx') {
    throw sheetInvalid(input.requestId, 'unsupported_format');
  }
  const parseRequest: DocumentParseContext = {
    teamId: input.teamId,
    datasetId: input.datasetId,
    fileRef: input.filename,
    extension,
    timeoutMs: 60_000,
    bytes: input.bytes,
  };
  const parsed = await createDefaultDocumentParser().parse(parseRequest);
  if (extension === 'xlsx' && (parsed.rawText.match(/^## /gm) ?? []).length > 1) {
    throw sheetInvalid(input.requestId, 'multiple_sheets');
  }
  const { header, rows } = parseMarkdownTable(parsed.rawText);
  if (header.length === 0) throw sheetInvalid(input.requestId, 'empty_sheet');
  const { qIndex, aIndex } = resolveColumns(header, input.mapping, input.requestId);
  return rows.map((cells) => ({
    q: cells[qIndex] ?? '',
    a: aIndex >= 0 ? (cells[aIndex] ?? '') : '',
  }));
}

/** API-IMP-001 POST /api/core/dataset/collection/import */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const form = await readMultipartForm(request);
    const filePart = form.files.file;
    if (!filePart || filePart.content.byteLength === 0) {
      throw sheetInvalid(requestId, 'missing_file');
    }
    if (filePart.content.byteLength > MAX_IMPORT_BYTES) {
      throw fail(501030, requestId, {
        limit: MAX_IMPORT_BYTES,
        actual: filePart.content.byteLength,
      });
    }
    const mapping = parseMapping(form.fields.mapping, requestId);
    const fields = parseDto<ImportFormFields>('DatasetImportForm', {
      file: filePart.content,
      datasetId: form.fields.datasetId,
      ...(form.fields.targetCollectionId !== undefined
        ? { targetCollectionId: form.fields.targetCollectionId }
        : {}),
      ...(mapping !== undefined ? { mapping } : {}),
    });
    const rows = await extractRows({
      bytes: filePart.content,
      filename: filePart.filename,
      datasetId: fields.datasetId,
      teamId: context.tenant.teamId,
      ...(mapping !== undefined ? { mapping } : {}),
      requestId,
    });
    if (rows.length > MAX_IMPORT_ROWS) {
      throw fail(501030, requestId, { limit: MAX_IMPORT_ROWS, actual: rows.length });
    }
    const options = { timeoutMs: 60_000 };
    const page = await runtime.collectionRepository.list(
      { datasetId: fields.datasetId, page: 1, limit: 1000, options },
      context,
    );
    let collectionId = fields.targetCollectionId ?? '';
    if (collectionId) {
      if (!page.list.some((collection) => collection.collectionId === collectionId)) {
        throw fail(501061, requestId, { fileId: '', datasetId: fields.datasetId });
      }
    } else {
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
    const datasetDetail = await runtime.datasetApi.getDatasetDetail(fields.datasetId, context);
    const report = { success: 0, skipped: 0, failed: 0, errors: [] as unknown[] };
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row) continue;
      if (row.error || row.q.trim().length === 0) {
        report.failed += 1;
        report.errors.push({
          row: index,
          code: row.error ?? 'empty_q',
          messageKey: 'dataset.import.row_failed',
          params: {},
        });
        continue;
      }
      try {
        const vectors = await runtime.embeddingService.embed(
          {
            models: { embeddingModel: datasetDetail.dataset.vectorModel },
            texts: [row.q],
            options,
          },
          context,
        );
        const result = await service.insertDirect(
          {
            dataId: randomBytes(12).toString('hex'),
            datasetId: fields.datasetId,
            collectionId,
            q: row.q,
            ...(row.a ? { a: row.a } : {}),
            indexVersion: datasetDetail.dataset.indexVersion,
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
  { validationErrorCode: 501058, maxRequestBodyBytes: MAX_IMPORT_BYTES },
);
