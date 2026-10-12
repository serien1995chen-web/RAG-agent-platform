import { ApiErrorException, createApiError } from '@kb/contracts';
import { createDefaultDocumentParser, type DocumentParseContext } from '@kb/parse';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import { readMultipartForm } from '../../file/presignUpload';
import { buildImportSource } from './file';

export const config = { api: { bodyParser: false } };

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_DATA_ROWS = 10000;

interface MappingColumn {
  sourceColumn: string;
  targetField: string;
  required?: boolean;
}

interface BackupFields {
  file: Uint8Array;
  datasetId: string;
  parentId?: string;
  mapping?: { sourceFormat?: string; columns?: MappingColumn[] };
}

function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(filename);
  return (match?.[1] ?? '').toLowerCase();
}

function fail(code: number, requestId: string, params: Record<string, unknown>): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

function cellsOf(line: string): string[] {
  return line
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function markdownTable(text: string): { header: string[]; rows: string[][] } {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'));
  if (lines.length === 0) return { header: [], rows: [] };
  const rows: string[][] = [];
  for (const line of lines.slice(1)) {
    if (/^\|[\s\-:|]+\|$/.test(line)) continue;
    rows.push(cellsOf(line));
  }
  return { header: cellsOf(lines[0] ?? ''), rows };
}

function validateHeader(
  header: string[],
  mapping: BackupFields['mapping'],
  requestId: string,
): void {
  const normalized = header.map((name) => name.toLowerCase());
  const seen = new Set<string>();
  const duplicateHeaders: string[] = [];
  for (const name of normalized) {
    if (name.length === 0) continue;
    if (seen.has(name)) {
      if (!duplicateHeaders.includes(name)) duplicateHeaders.push(name);
    } else seen.add(name);
  }
  if (duplicateHeaders.length > 0)
    throw fail(501058, requestId, { missingHeaders: [], duplicateHeaders });
  if (mapping?.columns && mapping.columns.length > 0) {
    const missingHeaders = mapping.columns
      .filter((column) => column.required)
      .map((column) => column.sourceColumn)
      .filter((name) => !normalized.includes(name.toLowerCase()));
    if (missingHeaders.length > 0)
      throw fail(501058, requestId, { missingHeaders, duplicateHeaders: [] });
    const qColumn = mapping.columns.find((column) => column.targetField === 'q');
    if (!qColumn || !normalized.includes(qColumn.sourceColumn.toLowerCase())) {
      throw fail(501058, requestId, { missingHeaders: ['q'], duplicateHeaders: [] });
    }
    return;
  }
  const missingHeaders: string[] = [];
  if (!normalized.includes('q')) missingHeaders.push('q');
  if (!normalized.includes('a')) missingHeaders.push('a');
  if (missingHeaders.length > 0)
    throw fail(501058, requestId, { missingHeaders, duplicateHeaders: [] });
}

/** API-COL-009 POST /api/core/dataset/collection/create/backup */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const form = await readMultipartForm(request);
    const filePart = form.files.file;
    if (!filePart || filePart.content.byteLength === 0) {
      throw fail(501059, requestId, { sheetName: '', reason: 'missing_file', limit: 1 });
    }
    const extension = extensionOf(filePart.filename);
    if (extension !== 'csv' && extension !== 'xlsx') {
      throw fail(501059, requestId, { sheetName: '', reason: 'unsupported_format', limit: 1 });
    }
    if (filePart.content.byteLength > MAX_IMPORT_BYTES) {
      throw fail(501030, requestId, {
        limit: MAX_IMPORT_BYTES,
        actual: filePart.content.byteLength,
      });
    }
    let mapping: BackupFields['mapping'];
    if (form.fields.mapping !== undefined) {
      try {
        mapping = JSON.parse(form.fields.mapping) as BackupFields['mapping'];
      } catch {
        throw fail(501058, requestId, { missingHeaders: [], duplicateHeaders: [] });
      }
    }
    const fields = parseDto<BackupFields>('CollectionCreateBackupForm', {
      file: filePart.content,
      datasetId: form.fields.datasetId,
      ...(form.fields.parentId !== undefined ? { parentId: form.fields.parentId } : {}),
      ...(mapping !== undefined ? { mapping } : {}),
    });
    const parseRequest: DocumentParseContext = {
      teamId: context.tenant.teamId,
      datasetId: fields.datasetId,
      fileRef: filePart.filename,
      extension,
      timeoutMs: 60_000,
      bytes: filePart.content,
    };
    const parsed = await createDefaultDocumentParser().parse(parseRequest);
    if (extension === 'xlsx' && (parsed.rawText.match(/^## /gm) ?? []).length > 1) {
      throw fail(501059, requestId, { sheetName: '', reason: 'multiple_sheets', limit: 1 });
    }
    const { header, rows } = markdownTable(parsed.rawText);
    if (header.length === 0) {
      throw fail(501059, requestId, { sheetName: '', reason: 'empty_sheet', limit: 1 });
    }
    validateHeader(header, mapping, requestId);
    if (rows.length > MAX_DATA_ROWS) {
      throw fail(501030, requestId, { limit: MAX_DATA_ROWS, actual: rows.length });
    }
    const service = buildImportSource(runtime);
    const result = await service.createCollectionFromSource(
      {
        collection: {
          teamId: context.tenant.teamId,
          datasetId: fields.datasetId,
          parentId: fields.parentId ?? null,
          type: 'backup',
          name: filePart.filename || 'backup',
          tagIds: [],
          trainingPolicy: null,
        },
        sourceType: 'text',
        sourceRef: parsed.rawText,
        options: { timeoutMs: 60_000 },
      },
      context,
    );
    response
      .status(200)
      .json(
        successResponse(
          { collectionId: result.collectionId, insertLen: result.insertLen },
          requestId,
        ),
      );
  },
  { validationErrorCode: 501058 },
);
