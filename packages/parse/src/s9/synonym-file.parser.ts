import { createRequire } from 'node:module';
import { createKnowledgeError } from '@kb/contracts';
import * as XLSX from 'xlsx';

export const SYNONYM_FILE_MAX_BYTES = 10 * 1024 * 1024;

export type SynonymFileFormat = 'csv' | 'xls' | 'xlsx';

export interface SynonymFileDiagnostic {
  rowNumber: number | null;
  columnNumber: number | null;
  code: string;
  messageKey: string;
  params: Record<string, string | number | boolean>;
}

export interface SynonymRawCell {
  columnNumber: number;
  value: string;
}

export interface SynonymRawRow {
  rowNumber: number;
  cells: SynonymRawCell[];
}

export interface ParsedSynonymFile {
  format: SynonymFileFormat;
  rows: SynonymRawRow[];
}

export interface ParseSynonymFileInput {
  fileName: string;
  bytes: Uint8Array;
  requestId: string;
  traceId: string;
}

interface PapaParseError {
  code?: string;
  row?: number;
}

interface PapaParseResult<T> {
  data: T[];
  errors: PapaParseError[];
}

interface PapaModule {
  parse<T>(
    input: string,
    config?: { delimiter?: string; skipEmptyLines?: boolean },
  ): PapaParseResult<T>;
}

const load = createRequire(import.meta.url);

function invalid(
  input: ParseSynonymFileInput,
  diagnostics: readonly SynonymFileDiagnostic[],
): never {
  throw createKnowledgeError({
    code: 'KNOWLEDGE_SYNONYM_INVALID',
    requestId: input.requestId,
    traceId: input.traceId,
    details: {
      diagnostics,
      totalDiagnostics: diagnostics.length,
      truncated: false,
    },
  });
}

function diagnostic(input: {
  rowNumber?: number | null;
  columnNumber?: number | null;
  code: string;
  params?: Record<string, string | number | boolean>;
}): SynonymFileDiagnostic {
  return {
    rowNumber: input.rowNumber ?? null,
    columnNumber: input.columnNumber ?? null,
    code: input.code,
    messageKey: `knowledge.synonym.invalid.${input.code.toLowerCase()}`,
    params: input.params ?? {},
  };
}

function extensionOf(fileName: string): string {
  const base = fileName.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const index = base.lastIndexOf('.');
  return index < 0 ? '' : base.slice(index + 1).toLowerCase();
}

function formatOf(fileName: string, input: ParseSynonymFileInput): SynonymFileFormat {
  const extension = extensionOf(fileName);
  if (extension === 'csv' || extension === 'xls' || extension === 'xlsx') return extension;
  return invalid(input, [
    diagnostic({
      code: 'UNSUPPORTED_FORMAT',
      params: { supported: 'csv,xls,xlsx' },
    }),
  ]);
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function assertContainerSignature(format: 'xls' | 'xlsx', input: ParseSynonymFileInput): void {
  const zip = startsWith(input.bytes, [0x50, 0x4b, 0x03, 0x04]);
  const ole = startsWith(input.bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if ((format === 'xlsx' && !zip) || (format === 'xls' && !ole)) {
    invalid(input, [
      diagnostic({
        code: 'FILE_SIGNATURE_MISMATCH',
        params: { format },
      }),
    ]);
  }
}

function decodeUtf8(input: ParseSynonymFileInput): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
  } catch {
    return invalid(input, [
      diagnostic({
        code: 'INVALID_UTF8',
        params: { encoding: 'utf-8' },
      }),
    ]);
  }
}

function rawRowsFromMatrix(rows: readonly unknown[][]): SynonymRawRow[] {
  return rows.map((row, index) => ({
    rowNumber: index + 1,
    cells: row.map((value, columnIndex) => ({
      columnNumber: columnIndex + 1,
      value: String(value ?? ''),
    })),
  }));
}

function parseCsv(input: ParseSynonymFileInput): SynonymRawRow[] {
  const text = decodeUtf8(input).replace(/^\ufeff/, '');
  if (text.length === 0) {
    return invalid(input, [diagnostic({ rowNumber: 1, code: 'EMPTY_FILE' })]);
  }
  const Papa = load('papaparse') as unknown as PapaModule;
  const parsed = Papa.parse<unknown[]>(text, {
    delimiter: ',',
    skipEmptyLines: false,
  });
  if (parsed.errors.length > 0) {
    return invalid(
      input,
      parsed.errors.slice(0, 20).map((error) =>
        diagnostic({
          rowNumber: Number.isInteger(error.row) ? Number(error.row) + 1 : null,
          code: 'CSV_PARSE_FAILED',
          params: { parserCode: error.code ?? 'unknown' },
        }),
      ),
    );
  }
  return rawRowsFromMatrix(parsed.data);
}

function parseSpreadsheet(format: 'xls' | 'xlsx', input: ParseSynonymFileInput): SynonymRawRow[] {
  assertContainerSignature(format, input);
  try {
    const workbook = XLSX.read(input.bytes, {
      type: 'array',
      cellDates: false,
      cellFormula: false,
      dense: true,
    });
    const firstSheetName = workbook.SheetNames[0];
    const firstSheet = firstSheetName ? workbook.Sheets[firstSheetName] : undefined;
    if (!firstSheetName || !firstSheet) {
      return invalid(input, [diagnostic({ code: 'WORKSHEET_REQUIRED' })]);
    }
    const rows = XLSX.utils.sheet_to_json<unknown[]>(firstSheet, {
      header: 1,
      raw: false,
      blankrows: true,
      defval: '',
    });
    return rawRowsFromMatrix(rows);
  } catch {
    return invalid(input, [
      diagnostic({
        code: 'WORKSHEET_PARSE_FAILED',
        params: { format },
      }),
    ]);
  }
}

export function readSynonymRows(input: ParseSynonymFileInput): ParsedSynonymFile {
  if (input.bytes.byteLength === 0) {
    return invalid(input, [diagnostic({ rowNumber: 1, code: 'EMPTY_FILE' })]);
  }
  if (input.bytes.byteLength > SYNONYM_FILE_MAX_BYTES) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
      requestId: input.requestId,
      traceId: input.traceId,
      details: {
        field: 'file',
        limitBytes: SYNONYM_FILE_MAX_BYTES,
        actualBytes: input.bytes.byteLength,
      },
    });
  }
  const format = formatOf(input.fileName, input);
  const rows = format === 'csv' ? parseCsv(input) : parseSpreadsheet(format, input);
  if (rows.length === 0) {
    return invalid(input, [diagnostic({ rowNumber: 1, code: 'HEADER_REQUIRED' })]);
  }
  return { format, rows };
}

export function parseSynonymFileBuffer(input: ParseSynonymFileInput): ParsedSynonymFile {
  return readSynonymRows(input);
}
