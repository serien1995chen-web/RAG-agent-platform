import { createRequire } from 'node:module';
import { createKnowledgeError } from '@kb/contracts';
import * as XLSX from 'xlsx';

export const IMPORT_TEMPLATE_LIMITS = Object.freeze({
  maxRows: 100_000,
  maxColumns: 1000,
  maxNonEmptyCells: 1_000_000,
  maxMetadataBytes: 16 * 1024,
});

export interface ImportTemplateRow {
  rowNumber: number;
  question: string;
  answer: string;
  indexes: string[];
  metadata: Record<string, unknown>;
  schemaVersion: number;
}

export interface ImportTemplateDiagnostic {
  rowNumber: number | null;
  code: string;
  message: string;
}

export interface ImportTemplateResult {
  format: 'csv' | 'xlsx';
  headers: string[];
  rows: ImportTemplateRow[];
  diagnostics: ImportTemplateDiagnostic[];
}

export interface ParseImportTemplateInput {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  backup: boolean;
}

interface PapaError {
  code?: string;
}

interface PapaResult<T> {
  data: T[];
  errors: PapaError[];
}

interface PapaModule {
  parse<T>(
    input: string,
    config?: {
      delimiter?: string;
      skipEmptyLines?: boolean | 'greedy';
    },
  ): PapaResult<T>;
}

const load = createRequire(import.meta.url);

function fail(
  requestId: string,
  traceId: string,
  code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' | 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
  rowNumber: number | null,
  reason: string,
): never {
  throw createKnowledgeError({
    code,
    requestId,
    traceId,
    details: { rowNumber, reason },
  });
}

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .replace(/^\ufeff/, '')
    .trim()
    .toLowerCase();
}

function decodeUtf8(bytes: Uint8Array, requestId: string, traceId: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail(requestId, traceId, 'KNOWLEDGE_UNSUPPORTED_CONTENT', null, 'csv_utf8_required');
  }
}

function parseMetadata(
  raw: string,
  rowNumber: number,
  requestId: string,
  traceId: string,
): Record<string, unknown> {
  if (raw.trim() === '') return {};
  if (Buffer.byteLength(raw, 'utf8') > IMPORT_TEMPLATE_LIMITS.maxMetadataBytes) {
    return fail(
      requestId,
      traceId,
      'KNOWLEDGE_UNSUPPORTED_CONTENT',
      rowNumber,
      'metadata_too_large',
    );
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail(
        requestId,
        traceId,
        'KNOWLEDGE_UNSUPPORTED_CONTENT',
        rowNumber,
        'metadata_object_required',
      );
    }
    return parsed as Record<string, unknown>;
  } catch {
    return fail(
      requestId,
      traceId,
      'KNOWLEDGE_UNSUPPORTED_CONTENT',
      rowNumber,
      'metadata_json_invalid',
    );
  }
}

function csvRows(input: ParseImportTemplateInput, requestId: string, traceId: string): unknown[][] {
  const Papa = load('papaparse') as unknown as PapaModule;
  const parsed = Papa.parse<unknown[]>(decodeUtf8(input.bytes, requestId, traceId), {
    skipEmptyLines: 'greedy',
  });
  if (parsed.errors.length > 0) {
    fail(
      requestId,
      traceId,
      'KNOWLEDGE_UNSUPPORTED_CONTENT',
      null,
      parsed.errors[0]?.code ?? 'csv_parse_failed',
    );
  }
  return parsed.data;
}

function xlsxRows(
  input: ParseImportTemplateInput,
  requestId: string,
  traceId: string,
): unknown[][] {
  try {
    const workbook = XLSX.read(input.bytes, { type: 'array', cellFormula: true });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return [];
    for (const [address, cell] of Object.entries(sheet)) {
      if (address.startsWith('!')) continue;
      const value = cell as { f?: string };
      if (typeof value.f === 'string' && value.f.length > 0) {
        fail(
          requestId,
          traceId,
          'KNOWLEDGE_UNSUPPORTED_CONTENT',
          XLSX.utils.decode_cell(address).r + 1,
          'formula_cell_forbidden',
        );
      }
    }
    return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      blankrows: false,
      defval: '',
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'KnowledgeApiError') throw error;
    return fail(requestId, traceId, 'KNOWLEDGE_UNSUPPORTED_CONTENT', null, 'xlsx_parse_failed');
  }
}

export function parseImportTemplate(
  input: ParseImportTemplateInput & { requestId: string; traceId: string },
): ImportTemplateResult {
  const extension = input.fileName.split('.').pop()?.toLowerCase();
  const format =
    extension === 'csv' || input.mimeType === 'text/csv'
      ? 'csv'
      : extension === 'xlsx' ||
          input.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ? 'xlsx'
        : null;
  if (!format) {
    return fail(
      input.requestId,
      input.traceId,
      'KNOWLEDGE_UNSUPPORTED_CONTENT',
      null,
      'csv_or_xlsx_required',
    );
  }
  const rows =
    format === 'csv'
      ? csvRows(input, input.requestId, input.traceId)
      : xlsxRows(input, input.requestId, input.traceId);
  if (rows.length === 0) {
    return fail(
      input.requestId,
      input.traceId,
      'KNOWLEDGE_UNSUPPORTED_CONTENT',
      null,
      'header_required',
    );
  }
  const headers = (rows[0] ?? []).map(normalizeHeader);
  const required = input.backup
    ? ['q', 'a', 'index', 'metadata', 'schemaVersion'.toLowerCase()]
    : ['q', 'a'];
  if (headers.length > IMPORT_TEMPLATE_LIMITS.maxColumns) {
    return fail(
      input.requestId,
      input.traceId,
      'KNOWLEDGE_PAYLOAD_TOO_LARGE',
      null,
      'max_columns_exceeded',
    );
  }
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    return fail(
      input.requestId,
      input.traceId,
      'KNOWLEDGE_UNSUPPORTED_CONTENT',
      1,
      `missing_headers:${missing.join(',')}`,
    );
  }
  const seen = new Set<string>();
  for (const header of headers) {
    if (!header) continue;
    if (seen.has(header) && header !== 'index') {
      return fail(
        input.requestId,
        input.traceId,
        'KNOWLEDGE_UNSUPPORTED_CONTENT',
        1,
        `duplicate_header:${header}`,
      );
    }
    seen.add(header);
  }
  const body = rows.slice(1);
  if (body.length > IMPORT_TEMPLATE_LIMITS.maxRows) {
    return fail(
      input.requestId,
      input.traceId,
      'KNOWLEDGE_PAYLOAD_TOO_LARGE',
      null,
      'max_rows_exceeded',
    );
  }
  const nonEmptyCells = body.reduce(
    (total, row) => total + row.filter((cell) => String(cell ?? '').trim().length > 0).length,
    0,
  );
  if (nonEmptyCells > IMPORT_TEMPLATE_LIMITS.maxNonEmptyCells) {
    return fail(
      input.requestId,
      input.traceId,
      'KNOWLEDGE_PAYLOAD_TOO_LARGE',
      null,
      'max_non_empty_cells_exceeded',
    );
  }
  const indexesOf = (value: unknown): string[] =>
    String(value ?? '')
      .split(/[|,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  const parsedRows: ImportTemplateRow[] = [];
  const primaryKeys = new Set<string>();
  for (const [index, row] of body.entries()) {
    const rowNumber = index + 2;
    if (
      row.some((cell) =>
        String(cell ?? '')
          .trim()
          .startsWith('='),
      )
    ) {
      return fail(
        input.requestId,
        input.traceId,
        'KNOWLEDGE_UNSUPPORTED_CONTENT',
        rowNumber,
        'formula_cell_forbidden',
      );
    }
    const cells = Object.fromEntries(headers.map((header, column) => [header, row[column]]));
    const question = String(cells.q ?? '').trim();
    const answer = String(cells.a ?? '').trim();
    if (!question) {
      return fail(
        input.requestId,
        input.traceId,
        'KNOWLEDGE_UNSUPPORTED_CONTENT',
        rowNumber,
        'empty_question',
      );
    }
    if (primaryKeys.has(question)) {
      return fail(
        input.requestId,
        input.traceId,
        'KNOWLEDGE_UNSUPPORTED_CONTENT',
        rowNumber,
        'duplicate_primary_key',
      );
    }
    primaryKeys.add(question);
    const schemaText = String(cells.schemaversion ?? '').trim();
    if (input.backup && schemaText === '') {
      return fail(
        input.requestId,
        input.traceId,
        'KNOWLEDGE_UNSUPPORTED_CONTENT',
        rowNumber,
        'schema_version_required',
      );
    }
    const schemaVersion = Number(schemaText);
    if (input.backup && (!Number.isInteger(schemaVersion) || schemaVersion !== 1)) {
      return fail(
        input.requestId,
        input.traceId,
        'KNOWLEDGE_UNSUPPORTED_CONTENT',
        rowNumber,
        'schema_version_mismatch',
      );
    }
    parsedRows.push({
      rowNumber,
      question,
      answer,
      indexes: indexesOf(cells.index),
      metadata: parseMetadata(
        String(cells.metadata ?? ''),
        rowNumber,
        input.requestId,
        input.traceId,
      ),
      schemaVersion: input.backup ? schemaVersion : 1,
    });
  }
  return { format, headers, rows: parsedRows, diagnostics: [] };
}
