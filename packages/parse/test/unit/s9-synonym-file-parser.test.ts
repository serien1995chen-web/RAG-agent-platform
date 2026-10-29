import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import {
  SYNONYM_FILE_MAX_BYTES,
  parseSynonymFileBuffer,
  type ParseSynonymFileInput,
} from '../../src/s9/synonym-file.parser';

const context = {
  requestId: 'req_s9_parser',
  traceId: 'trace_s9_parser'.padEnd(32, '0'),
};

function input(fileName: string, bytes: Uint8Array): ParseSynonymFileInput {
  return { ...context, fileName, bytes };
}

function workbookBytes(bookType: 'xls' | 'xlsx'): Uint8Array {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['标准词', '同义词'],
      ['退款', '退货'],
    ]),
    'First',
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([['not-a-synonym-header'], ['ignored', 'ignored']]),
    'Second',
  );
  const value = XLSX.write(workbook, {
    type: 'buffer',
    bookType,
  }) as Buffer;
  return value;
}

describe('S9 synonym file parser', () => {
  it('TEST-SEARCH-003-BLOCK parses BOM CSV with CRLF and source coordinates', () => {
    const bytes = Buffer.from('\ufeff标准词,同义词1,同义词2\r\n退款,退货,返还\r\n配送,发货,\r\n');
    const parsed = parseSynonymFileBuffer(input('synonyms.csv', bytes));
    expect(parsed.format).toBe('csv');
    expect(parsed.rows[0]).toMatchObject({
      rowNumber: 1,
      cells: [
        { columnNumber: 1, value: '标准词' },
        { columnNumber: 2, value: '同义词1' },
        { columnNumber: 3, value: '同义词2' },
      ],
    });
    expect(parsed.rows[2]).toMatchObject({
      rowNumber: 3,
      cells: [
        { columnNumber: 1, value: '配送' },
        { columnNumber: 2, value: '发货' },
        { columnNumber: 3, value: '' },
      ],
    });
  });

  it('TEST-SEARCH-003-BLOCK reads only the first worksheet for XLS and XLSX', () => {
    for (const format of ['xls', 'xlsx'] as const) {
      const parsed = parseSynonymFileBuffer(input(`synonyms.${format}`, workbookBytes(format)));
      expect(parsed.format).toBe(format);
      expect(parsed.rows.map((row) => row.cells.map((cell) => cell.value))).toEqual([
        ['标准词', '同义词'],
        ['退款', '退货'],
      ]);
    }
  });

  it('TEST-SEARCH-003-BLOCK rejects invalid UTF-8 and forged spreadsheet extensions', () => {
    expect(() =>
      parseSynonymFileBuffer(input('synonyms.csv', Buffer.from([0xff, 0xfe, 0xfd]))),
    ).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_SYNONYM_INVALID' }),
        }),
      }),
    );
    expect(() =>
      parseSynonymFileBuffer(input('synonyms.xlsx', Buffer.from('标准词,同义词\n退款,退货'))),
    ).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_SYNONYM_INVALID' }),
        }),
      }),
    );
  });

  it('TEST-SEARCH-003-BLOCK enforces supported extensions and the 10 MiB boundary', () => {
    expect(() =>
      parseSynonymFileBuffer(input('synonyms.txt', Buffer.from('标准词,同义词'))),
    ).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_SYNONYM_INVALID' }),
        }),
      }),
    );
    expect(() =>
      parseSynonymFileBuffer(input('synonyms.csv', Buffer.alloc(SYNONYM_FILE_MAX_BYTES + 1))),
    ).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE' }),
        }),
      }),
    );
  });
});
