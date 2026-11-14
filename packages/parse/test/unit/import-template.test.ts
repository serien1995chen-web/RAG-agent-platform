import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { parseImportTemplate } from '../../src/import-template';

const requestId = 'req-template';
const traceId = 'trace-template';

function fixture(input: Partial<Parameters<typeof parseImportTemplate>[0]> = {}) {
  return {
    fileName: 'template.csv',
    mimeType: 'text/csv',
    bytes: Buffer.from('q,a,index,metadata\nQuestion,Answer,ia,{"source":"csv"}\n'),
    backup: false,
    requestId,
    traceId,
    ...input,
  };
}

function expectUnsupported(run: () => void, rowNumber?: number, label?: string): void {
  try {
    run();
    throw new Error(`expected KNOWLEDGE_UNSUPPORTED_CONTENT${label ? `: ${label}` : ''}`);
  } catch (error) {
    expect(error).toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
          ...(rowNumber === undefined ? {} : { details: { rowNumber } }),
        },
      },
    });
  }
}

function expectPayloadTooLarge(run: () => void): void {
  try {
    run();
    throw new Error('expected KNOWLEDGE_PAYLOAD_TOO_LARGE');
  } catch (error) {
    expect(error).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE' } },
    });
  }
}

describe('S4 CSV/XLSX import template parser', () => {
  it('TEST-ING-004-BLOCK parses q/a/index/metadata without parsing document content', () => {
    const result = parseImportTemplate(fixture());
    expect(result.format).toBe('csv');
    expect(result.rows).toEqual([
      expect.objectContaining({
        rowNumber: 2,
        question: 'Question',
        answer: 'Answer',
        indexes: ['ia'],
        metadata: { source: 'csv' },
      }),
    ]);
  });

  it('L1-B08-ING-004-N01 rejects missing, repeated q-like headers and invalid metadata', () => {
    expectUnsupported(() => parseImportTemplate(fixture({ bytes: Buffer.from('q\nQuestion\n') })));
    expectUnsupported(
      () => parseImportTemplate(fixture({ bytes: Buffer.from('q,q,a\nQuestion,Other,Answer\n') })),
      1,
    );
    expectUnsupported(
      () =>
        parseImportTemplate(fixture({ bytes: Buffer.from('q,a,metadata\nQuestion,Answer,[]\n') })),
      2,
    );
  });

  it('L1-B08-ING-004-P01 preserves BOM, CRLF, quoting and multiline CSV fields', () => {
    const result = parseImportTemplate(
      fixture({
        bytes: Buffer.from(
          '\ufeffq,a,index,metadata\r\n' +
            '"中文问题🙌","第一行, 含逗号\r\n第二行 ""引号""",主题|别名,"{""来源"":""CSV""}"\r\n',
          'utf8',
        ),
      }),
    );

    expect(result.rows).toEqual([
      {
        rowNumber: 2,
        question: '中文问题🙌',
        answer: '第一行, 含逗号\r\n第二行 "引号"',
        indexes: ['主题', '别名'],
        metadata: { 来源: 'CSV' },
        schemaVersion: 1,
      },
    ]);
  });

  it('L1-B08-ING-004-N01 keeps duplicate questions but skips fully empty rows', () => {
    const result = parseImportTemplate(
      fixture({
        bytes: Buffer.from('q,a\r\nSame,One\r\n,\r\nSame,Two\r\n,\r\n'),
      }),
    );

    expect(result.rows.map((row) => [row.rowNumber, row.question, row.answer])).toEqual([
      [2, 'Same', 'One'],
      [4, 'Same', 'Two'],
    ]);
  });

  it('L1-B08-ING-004-N01 preserves q-only and a-only non-empty rows', () => {
    const result = parseImportTemplate(
      fixture({
        bytes: Buffer.from('q,a\nQuestion only,\n,Answer only\n'),
      }),
    );

    expect(result.rows.map((row) => [row.question, row.answer])).toEqual([
      ['Question only', ''],
      ['', 'Answer only'],
    ]);
  });

  it('L1-B08-ING-004-N01 accepts repeated index and indexes columns', () => {
    const repeated = parseImportTemplate(
      fixture({
        bytes: Buffer.from(
          'q,a,index,index,metadata\nQuestion,Answer,first,second,{"source":"csv"}\n',
        ),
      }),
    );
    const legacy = parseImportTemplate(
      fixture({
        bytes: Buffer.from('q,a,indexes\nQuestion,Answer,first|second\n'),
      }),
    );

    expect(repeated.rows[0]?.indexes).toEqual(['first', 'second']);
    expect(legacy.rows[0]?.indexes).toEqual(['first', 'second']);
  });

  it('L1-B08-ING-004-N01 accepts a legal header-only file without inventing rows', () => {
    const csv = parseImportTemplate(fixture({ bytes: Buffer.from('\ufeffq,a\r\n\r\n') }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['q', 'a']]), 'only');
    const xlsx = parseImportTemplate(
      fixture({
        fileName: 'header-only.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })),
      }),
    );

    expect(csv.rows).toEqual([]);
    expect(xlsx.rows).toEqual([]);
  });

  it('TEST-ING-004-U02 rejects CSV formula markers and preserves safe negative numbers', () => {
    for (const marker of [
      '=SUM(1,2)',
      '+SUM(1,2)',
      '-1+1',
      '@SUM(1,2)',
      '  =SUM(1,2)',
      '\t@SUM(1,2)',
    ]) {
      const encoded = marker.startsWith('\t') ? marker : JSON.stringify(marker);
      expectUnsupported(
        () => parseImportTemplate(fixture({ bytes: Buffer.from(`q,a\n${encoded},Answer\n`) })),
        undefined,
        marker,
      );
    }
    const negative = parseImportTemplate(fixture({ bytes: Buffer.from('q,a\n-42.5,Answer\n') }));
    expect(negative.rows[0]?.question).toBe('-42.5');
  });

  it('TEST-ING-004-U03 rejects column limits before row materialization', () => {
    const header = Array.from({ length: 1001 }, (_, index) => `c${index}`).join(',');
    expectPayloadTooLarge(() =>
      parseImportTemplate(fixture({ bytes: Buffer.from(`${header}\n${header}\n`) })),
    );
  });

  it('L1-B08-ING-004-Q01 rejects over-limit rows, metadata and non-empty cells', () => {
    const rows = Array.from({ length: 100_001 }, (_, index) => `Q${index},A${index}`).join('\n');
    expectPayloadTooLarge(() =>
      parseImportTemplate(fixture({ bytes: Buffer.from(`q,a\n${rows}\n`) })),
    );
    expectUnsupported(
      () =>
        parseImportTemplate(
          fixture({
            bytes: Buffer.from(
              `q,a,metadata\nQuestion,Answer,{"value":"${'x'.repeat(17 * 1024)}"}\n`,
            ),
          }),
        ),
      2,
    );
    const header = ['q', 'a', ...Array.from({ length: 999 }, (_, index) => `c${index}`)].join(',');
    const body = Array.from({ length: 1001 }, () => header).join('\n');
    expectPayloadTooLarge(() =>
      parseImportTemplate(fixture({ bytes: Buffer.from(`${header}\n${body}\n`) })),
    );
  });

  it('L1-B08-ING-004-N01 rejects unsupported extensions and content/extension mismatches', () => {
    expectUnsupported(() =>
      parseImportTemplate(
        fixture({
          fileName: 'template.txt',
          mimeType: 'text/csv',
          bytes: Buffer.from('q,a\nQuestion,Answer\n'),
        }),
      ),
    );
    expectUnsupported(() =>
      parseImportTemplate(
        fixture({
          fileName: 'template.csv',
          mimeType: 'text/csv',
          bytes: Buffer.from('PK\u0003\u0004not-a-csv\u0000', 'binary'),
        }),
      ),
    );
  });

  it('TEST-ING-005-BLOCK accepts schemaVersion=1 backup rows', () => {
    const result = parseImportTemplate(
      fixture({
        backup: true,
        bytes: Buffer.from('q,a,index,metadata,schemaVersion\nQuestion,Answer,,"{}",1\n'),
      }),
    );
    expect(result.rows[0]?.schemaVersion).toBe(1);
  });

  it('L1-B08-ING-005-P01 accepts FastGPT q,a CSV backups without enhancement columns', () => {
    const result = parseImportTemplate(
      fixture({
        backup: true,
        bytes: Buffer.from('\ufeffq,a\r\nQuestion,Answer\r\n'),
      }),
    );

    expect(result.rows).toEqual([
      {
        rowNumber: 2,
        question: 'Question',
        answer: 'Answer',
        indexes: [],
        metadata: {},
        schemaVersion: 1,
      },
    ]);
  });

  it('TEST-ING-005-U01 rejects missing and mixed backup schema versions', () => {
    expectUnsupported(
      () =>
        parseImportTemplate(
          fixture({
            backup: true,
            bytes: Buffer.from('q,a,index,metadata,schemaVersion\nQuestion,Answer,,"{}",\n'),
          }),
        ),
      2,
    );
    expectUnsupported(
      () =>
        parseImportTemplate(
          fixture({
            backup: true,
            bytes: Buffer.from('q,a,index,metadata,schemaVersion\nQuestion,Answer,,"{}",2\n'),
          }),
        ),
      2,
    );
  });

  it('L1-B08-ING-004-N01 rejects multiple worksheets even when the first sheet is valid', () => {
    const workbook = XLSX.utils.book_new();
    const first = XLSX.utils.aoa_to_sheet([
      ['q', 'a'],
      ['Question', 'Answer'],
    ]);
    const second = XLSX.utils.aoa_to_sheet([['ignored'], ['value']]);
    XLSX.utils.book_append_sheet(workbook, first, 'First');
    XLSX.utils.book_append_sheet(workbook, second, 'Second');
    const bytes = new Uint8Array(
      XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer,
    );
    expectUnsupported(() =>
      parseImportTemplate(
        fixture({
          fileName: 'template.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          bytes,
        }),
      ),
    );
  });

  it('L1-B08-ING-004-N01 rejects merged cells and formula cells in XLSX', () => {
    const mergedWorkbook = XLSX.utils.book_new();
    const mergedSheet = XLSX.utils.aoa_to_sheet([
      ['q', 'a'],
      ['Question', 'Answer'],
    ]);
    mergedSheet['!merges'] = [{ s: { r: 1, c: 0 }, e: { r: 2, c: 0 } }];
    XLSX.utils.book_append_sheet(mergedWorkbook, mergedSheet, 'Merged');
    const mergedBytes = new Uint8Array(
      XLSX.write(mergedWorkbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer,
    );
    expectUnsupported(() =>
      parseImportTemplate(
        fixture({
          fileName: 'template.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          bytes: mergedBytes,
        }),
      ),
    );

    const formulaWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      formulaWorkbook,
      XLSX.utils.aoa_to_sheet([
        ['q', 'a'],
        ['Question', { f: '1+1', v: 2 }],
      ]),
      'Formula',
    );
    const formulaBytes = new Uint8Array(
      XLSX.write(formulaWorkbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer,
    );
    expect(() =>
      parseImportTemplate(
        fixture({
          fileName: 'template.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          bytes: formulaBytes,
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' }),
        }),
      }),
    );
  });
});
