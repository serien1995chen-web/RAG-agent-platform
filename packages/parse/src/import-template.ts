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

function isFormulaInjection(value: unknown): boolean {
  const normalized = String(value ?? '').trimStart();
  if (/^[=+@]/.test(normalized)) return true;
  if (!normalized.startsWith('-')) return false;
  return !/^-(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized);
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
  const parsed = Papa.parse<unknown[]>(decodeUtf8(input.bytes, requestId, traceId));
  const structuralErrors = parsed.errors.filter((error) => error.code !== 'UndetectableDelimiter');
  if (structuralErrors.length > 0) {
    fail(
      requestId,
      traceId,
      'KNOWLEDGE_UNSUPPORTED_CONTENT',
      null,
      structuralErrors[0]?.code ?? 'csv_parse_failed',
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
    if (workbook.SheetNames.length !== 1) {
      return fail(
        requestId,
        traceId,
        'KNOWLEDGE_UNSUPPORTED_CONTENT',
        null,
        'exactly_one_worksheet_required',
      );
    }
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return [];
    if ((sheet['!merges']?.length ?? 0) > 0) {
      return fail(
        requestId,
        traceId,
        'KNOWLEDGE_UNSUPPORTED_CONTENT',
        null,
        'merged_cells_forbidden',
      );
    }
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
  const format = extension === 'csv' ? 'csv' : extension === 'xlsx' ? 'xlsx' : null;
  if (!format) {
    return fail(
      input.requestId,
      input.traceId,
      'KNOWLEDGE_UNSUPPORTED_CONTENT',
      null,
      'csv_or_xlsx_required',
    );
  }
  const zipMagic =
    input.bytes.byteLength >= 4 &&
    input.bytes[0] === 0x50 &&
    input.bytes[1] === 0x4b &&
    input.bytes[2] === 0x03 &&
    input.bytes[3] === 0x04;
  if (format === 'csv' && zipMagic) {
    return fail(
      input.requestId,
      input.traceId,
      'KNOWLEDGE_UNSUPPORTED_CONTENT',
      null,
      'csv_content_required',
    );
  }
  if (format === 'xlsx' && !zipMagic) {
    return fail(
      input.requestId,
      input.traceId,
      'KNOWLEDGE_UNSUPPORTED_CONTENT',
      null,
      'xlsx_container_required',
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
  const required = ['q', 'a'];
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
  const allowedHeaders = new Set(['q', 'a', 'index', 'indexes', 'metadata', 'schemaversion']);
  const unknownHeader = headers.find((header) => !allowedHeaders.has(header));
  if (unknownHeader !== undefined) {
    return fail(
      input.requestId,
      input.traceId,
      'KNOWLEDGE_UNSUPPORTED_CONTENT',
      1,
      `unknown_header:${unknownHeader}`,
    );
  }
  const seen = new Set<string>();
  for (const header of headers) {
    if (!header) continue;
    if (seen.has(header) && header !== 'index' && header !== 'indexes') {
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
  const questionColumn = headers.indexOf('q');
  const answerColumn = headers.indexOf('a');
  const metadataColumn = headers.indexOf('metadata');
  const schemaVersionColumn = headers.indexOf('schemaversion');
  const indexColumns = headers.flatMap((header, column) =>
    header === 'index' || header === 'indexes' ? [column] : [],
  );
  const legacyIndexesStart =
    metadataColumn < 0 &&
    schemaVersionColumn < 0 &&
    indexColumns.length === 1 &&
    headers[indexColumns[0]!] === 'indexes'
      ? indexColumns[0]
      : undefined;
  const indexesOf = (row: unknown[]): string[] =>
    (legacyIndexesStart === undefined
      ? indexColumns.map((column) => row[column])
      : row.slice(legacyIndexesStart)
    )
      .flatMap((value) => String(value ?? '').split(/[|,]/))
      .map((entry) => entry.trim())
      .filter(Boolean);
  const parsedRows: ImportTemplateRow[] = [];
  for (const [index, row] of body.entries()) {
    const rowNumber = index + 2;
    if (row.every((cell) => String(cell ?? '').trim() === '')) continue;
    if (row.some(isFormulaInjection)) {
      return fail(
        input.requestId,
        input.traceId,
        'KNOWLEDGE_UNSUPPORTED_CONTENT',
        rowNumber,
        'formula_cell_forbidden',
      );
    }
    const question = String(row[questionColumn] ?? '').trim();
    const answer = String(row[answerColumn] ?? '').trim();
    if (!question && !answer) continue;
    const schemaText =
      schemaVersionColumn >= 0 ? String(row[schemaVersionColumn] ?? '').trim() : '';
    if (schemaVersionColumn >= 0 && schemaText === '') {
      return fail(
        input.requestId,
        input.traceId,
        'KNOWLEDGE_UNSUPPORTED_CONTENT',
        rowNumber,
        'schema_version_required',
      );
    }
    const schemaVersion = schemaVersionColumn >= 0 ? Number(schemaText) : 1;
    if (schemaVersionColumn >= 0 && (!Number.isInteger(schemaVersion) || schemaVersion !== 1)) {
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
      indexes: indexesOf(row),
      metadata: parseMetadata(
        metadataColumn >= 0 ? String(row[metadataColumn] ?? '') : '',
        rowNumber,
        input.requestId,
        input.traceId,
      ),
      schemaVersion: input.backup ? schemaVersion : 1,
    });
  }
  return { format, headers, rows: parsedRows, diagnostics: [] };
}
