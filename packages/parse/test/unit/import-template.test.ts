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

  it('TEST-ING-004-U01 rejects missing/duplicate q and invalid metadata with rowNumber', () => {
    expectUnsupported(() => parseImportTemplate(fixture({ bytes: Buffer.from('q\nQuestion\n') })));
    expectUnsupported(
      () =>
        parseImportTemplate(
          fixture({ bytes: Buffer.from('q,a\nQuestion,Answer\nQuestion,Other\n') }),
        ),
      3,
    );
    expectUnsupported(
      () =>
        parseImportTemplate(fixture({ bytes: Buffer.from('q,a,metadata\nQuestion,Answer,[]\n') })),
      2,
    );
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

  it('TEST-ING-005-BLOCK accepts schemaVersion=1 backup rows', () => {
    const result = parseImportTemplate(
      fixture({
        backup: true,
        bytes: Buffer.from('q,a,index,metadata,schemaVersion\nQuestion,Answer,,"{}",1\n'),
      }),
    );
    expect(result.rows[0]?.schemaVersion).toBe(1);
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

  it('TEST-ING-004-U02 reads only the first XLSX sheet and rejects formula cells', () => {
    const workbook = XLSX.utils.book_new();
    const first = XLSX.utils.aoa_to_sheet([
      ['q', 'a'],
      ['Question', { f: '1+1', v: 2 }],
    ]);
    const second = XLSX.utils.aoa_to_sheet([['ignored'], ['value']]);
    XLSX.utils.book_append_sheet(workbook, first, 'First');
    XLSX.utils.book_append_sheet(workbook, second, 'Second');
    const bytes = new Uint8Array(
      XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer,
    );
    expect(() =>
      parseImportTemplate(
        fixture({
          fileName: 'template.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          bytes,
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
