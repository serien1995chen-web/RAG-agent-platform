/**
 * @kb/parse XLSX 解析（设计 9.8.1）：yauzl 预检 + 工作表转 Markdown；
 * 多表按 Sheet 分隔，合并单元格展平；预检超限 501053。
 */
import * as XLSX from 'xlsx';
import type { ParseHandler } from '../format-registry';
import { parseError, parseFailedError } from '../format-registry';
import { makeResult, normalizeRawText, toMarkdownTable } from './core';
import { openZipEntries, ZipLimitError } from './zip-reader';

const MAX_SHEETS = 200;
const MAX_SHEET_BYTES = 64 * 1024 * 1024;

export const parseXlsx: ParseHandler = async (context) => {
  const requestId = context.request.fileRef;
  try {
    await openZipEntries(context.bytes, {
      maxEntries: MAX_SHEETS * 20,
      maxEntryBytes: MAX_SHEET_BYTES,
    });
  } catch (error) {
    if (error instanceof ZipLimitError) {
      throw parseError(501053, requestId, {
        maxChunks: MAX_SHEETS,
        actual: MAX_SHEETS + 1,
        chunkSize: MAX_SHEET_BYTES,
      });
    }
    throw parseFailedError('xlsx', 'xlsx_precheck_failed', requestId);
  }

  try {
    const workbook = XLSX.read(context.bytes, { type: 'array', cellDates: true });
    if (workbook.SheetNames.length > MAX_SHEETS) {
      throw parseError(501053, requestId, {
        maxChunks: MAX_SHEETS,
        actual: workbook.SheetNames.length,
        chunkSize: MAX_SHEET_BYTES,
      });
    }
    const sections = workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) return `## ${sheetName}`;
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
        header: 1,
        raw: false,
        blankrows: false,
      });
      const header = (rows[0] ?? []).map((cell) => String(cell ?? ''));
      const body = rows.slice(1).map((row) => row.map((cell) => String(cell ?? '')));
      if (header.length === 0) return `## ${sheetName}`;
      return `## ${sheetName}\n\n${toMarkdownTable(header, body)}`;
    });
    return makeResult('xlsx', normalizeRawText(sections.join('\n\n')));
  } catch (error) {
    if (error instanceof Error && error.name === 'ApiErrorException') throw error;
    throw parseFailedError('xlsx', 'xlsx_parse_failed', requestId);
  }
};
