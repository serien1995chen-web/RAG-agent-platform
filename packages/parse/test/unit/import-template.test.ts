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

describe('S4 CSV/XLSX import template parser', () => {
  it('parses q/a/index/metadata without parsing document content', () => {
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

  it('rejects formula cells instead of executing them', () => {
    expect(() =>
      parseImportTemplate(fixture({ bytes: Buffer.from('q,a\n=SUM(1,2),Answer\n') })),
    ).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' }),
        }),
      }),
    );
  });

  it('rejects missing and mixed backup schema versions', () => {
    expect(() =>
      parseImportTemplate(
        fixture({
          backup: true,
          bytes: Buffer.from('q,a,index,metadata,schemaVersion\nQuestion,Answer,,"{}",\n'),
        }),
      ),
    ).toThrow();
    expect(() =>
      parseImportTemplate(
        fixture({
          backup: true,
          bytes: Buffer.from('q,a,index,metadata,schemaVersion\nQuestion,Answer,,"{}",2\n'),
        }),
      ),
    ).toThrow();
  });

  it('reads only the first XLSX sheet and rejects formula cells', () => {
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
