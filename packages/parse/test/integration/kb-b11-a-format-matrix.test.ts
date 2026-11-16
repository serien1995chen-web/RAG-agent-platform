import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contentHashOf,
  createDefaultDocumentParser,
  type DocumentParseContext,
} from '../../src/index';
import {
  B11_FIXTURE_CONTENT,
  b11EncryptedPdf,
  b11PdfWithoutText,
  b11PdfWithText,
  b11PptxWithNotes,
  b11XlsxTwoSheets,
  sha256,
} from '../../../../test/fixtures/b11/generate-fixtures';
import { S5_FIXTURES, docxBytes, hostileZip } from '../../../../test/fixtures/s5/generate-fixtures';

const parser = createDefaultDocumentParser();
const s5Manifest = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'test',
      'fixtures',
      's5',
      'fixture-manifest.json',
    ),
    'utf8',
  ),
) as { fixtures: Record<string, { sha256: string }> };

function request(extension: string, bytes: Uint8Array, mimeType?: string): DocumentParseContext {
  return {
    workspaceId: 'ws_b11_parse',
    knowledgeSpaceId: 'space_b11_parse',
    sourceId: 'source_b11_parse',
    fileRef: `b11-fixture.${extension}`,
    extension,
    ...(mimeType ? { mimeType } : {}),
    timeoutMs: 60_000,
    bytes,
  };
}

function expectKnowledgeError(error: unknown, code: string) {
  expect(error).toMatchObject({ problem: { error: { code } } });
}

describe('L1-B11-A PARSE-001 format and boundary matrix', () => {
  it('L1-B11-A-PARSE-001-P01 parses every required format with traceable metadata', async () => {
    const cases = [
      {
        extension: 'txt',
        bytes: Buffer.from(B11_FIXTURE_CONTENT.text),
        mime: 'text/plain',
        expected: ['B11 TXT 正文'],
      },
      {
        extension: 'md',
        bytes: Buffer.from(B11_FIXTURE_CONTENT.markdown),
        mime: 'text/markdown',
        expected: ['# B11 Markdown', '| q | a |'],
      },
      {
        extension: 'html',
        bytes: Buffer.from(B11_FIXTURE_CONTENT.html),
        mime: 'text/html',
        expected: ['B11 HTML'],
        absent: ['bad()'],
      },
      {
        extension: 'pdf',
        bytes: b11PdfWithText(),
        mime: 'application/pdf',
        expected: ['B11 text layer document'],
      },
      {
        extension: 'docx',
        bytes: docxBytes('B11 DOCX body'),
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        expected: ['B11 DOCX body'],
      },
      {
        extension: 'pptx',
        bytes: b11PptxWithNotes(),
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        expected: ['## Slide 1', 'B11 slide body', 'B11 speaker notes', '## Slide 2'],
      },
      {
        extension: 'xlsx',
        bytes: b11XlsxTwoSheets(),
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        expected: ['## First', '## Second', '| name | value |', 'alpha', 'beta'],
      },
      {
        extension: 'csv',
        bytes: Buffer.from(B11_FIXTURE_CONTENT.csv),
        mime: 'text/csv',
        expected: ['| q | a |', 'B11 question', 'B11 answer'],
      },
      {
        extension: 'epub',
        bytes: S5_FIXTURES.epub,
        mime: 'application/epub+zip',
        expected: ['S5 ebook'],
      },
      {
        extension: 'ofd',
        bytes: S5_FIXTURES.ofd,
        mime: 'application/ofd',
        expected: ['## Page 1', 'OFD page one', '## Page 2', 'OFD page two'],
      },
    ] as const;

    for (const fixture of cases) {
      const result = await parser.parse(request(fixture.extension, fixture.bytes, fixture.mime));
      expect(result.rawText.trim().length, fixture.extension).toBeGreaterThan(0);
      expect(result.contentHash, fixture.extension).toBe(contentHashOf(result.rawText));
      expect(result.configHash, fixture.extension).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.parserVersion, fixture.extension).toBeTruthy();
      expect(result.pages.length, fixture.extension).toBeGreaterThan(0);
      for (const expected of fixture.expected) {
        expect(result.rawText, `${fixture.extension}: ${expected}`).toContain(expected);
      }
      for (const absent of fixture.absent ?? []) {
        expect(result.rawText, `${fixture.extension}: ${absent}`).not.toContain(absent);
      }
    }

    const ofd = await parser.parse(request('ofd', S5_FIXTURES.ofd, 'application/ofd'));
    expect(ofd.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(ofd.assets).toHaveLength(1);
    expect(ofd.assets[0]?.mimeType).toBe('image/png');
    expect(ofd.assets[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ofd.assets[0]?.objectRefId).toBeUndefined();
  });

  it('L1-B11-A-PARSE-001-P02 anydoc detects the concrete format before dispatch', async () => {
    const pdf = await parser.parse(request('anydoc', b11PdfWithText(), 'application/x-anydoc'));
    expect(pdf.format).toBe('pdf');
    expect(pdf.rawText).toContain('B11 text layer document');

    const docx = await parser.parse(
      request('anydoc', docxBytes('AnyDoc B11'), 'application/x-anydoc'),
    );
    expect(docx.format).toBe('docx');
    expect(docx.rawText).toContain('AnyDoc B11');

    const text = await parser.parse(
      request('anydoc', Buffer.from('AnyDoc plain text'), 'application/x-anydoc'),
    );
    expect(text.format).toBe('text');
    expect(text.rawText).toContain('AnyDoc plain text');
  });

  it('L1-B11-A-PARSE-001-N01 corrupt and unknown documents fail without empty success', async () => {
    for (const input of [
      request('pdf', Buffer.from('%PDF-1.7\nnot a complete document'), 'application/pdf'),
      request(
        'docx',
        Buffer.from('not a zip'),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
      request('ofd', Buffer.from('not an OFD zip'), 'application/ofd'),
      request('anydoc', Buffer.from([0, 1, 2, 3]), 'application/x-anydoc'),
      request('unknown', Buffer.from('unknown'), 'application/octet-stream'),
    ]) {
      const error = await parser.parse(input).catch((caught: unknown) => caught);
      expectKnowledgeError(error, 'KNOWLEDGE_UNSUPPORTED_CONTENT');
    }
  });

  it('L1-B11-A-PARSE-001-N02 rejects MIME and extension disagreement instead of parsing by filename', async () => {
    const error = await parser
      .parse(request('txt', Buffer.from('disguised text'), 'application/pdf'))
      .catch((caught: unknown) => caught);
    expectKnowledgeError(error, 'KNOWLEDGE_UNSUPPORTED_CONTENT');
  });

  it('L1-B11-A-PARSE-001-N03 rejects encrypted and text-less PDFs unless the product OCR path is declared', async () => {
    const encrypted = await parser
      .parse(request('pdf', b11EncryptedPdf(), 'application/pdf'))
      .catch((caught: unknown) => caught);
    expectKnowledgeError(encrypted, 'KNOWLEDGE_UNSUPPORTED_CONTENT');

    const textless = await parser.parse(request('pdf', b11PdfWithoutText(), 'application/pdf'));
    expect(textless.scanRequired).toBe(true);
    expect(textless.rawText.trim()).toBe('');
    expect(textless.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'pdf_text_layer_missing' }),
    );
  });

  it('L1-B11-A-PARSE-001-F01 only WASM load/init errors invoke PDF.js fallback', async () => {
    const { parseWithLiteParse } = await import('../../src/index');
    const context = {
      request: request('pdf', b11PdfWithText(), 'application/pdf'),
      bytes: b11PdfWithText(),
      mimeType: 'application/pdf',
    };
    const fallback = await parseWithLiteParse(context, {
      loader: async () => {
        throw new Error('wasm load failed');
      },
      config: { fallbackPdfJsOnWasmLoadError: true },
    });
    expect(fallback.parserVersion).toContain('pdfjs@');
    expect(fallback.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'liteparse_load_fallback' }),
    );

    const contentFailure = await parseWithLiteParse(context, {
      loader: async () => ({
        LiteParse: class {
          async parse(): Promise<unknown> {
            throw new Error('corrupt PDF content');
          }
          free(): void {}
        },
      }),
      config: { fallbackPdfJsOnWasmLoadError: true },
    }).catch((caught: unknown) => caught);
    expectKnowledgeError(contentFailure, 'KNOWLEDGE_UNSUPPORTED_CONTENT');
  });

  it('L1-B11-A-PARSE-001-Q01 rejects OFD traversal and preserves source fixture fingerprints', async () => {
    const error = await parser
      .parse(request('ofd', hostileZip(), 'application/ofd'))
      .catch((caught: unknown) => caught);
    expectKnowledgeError(error, 'KNOWLEDGE_UNSUPPORTED_CONTENT');

    expect(sha256(S5_FIXTURES.ofd)).toBe(s5Manifest.fixtures.ofd?.sha256);
    expect(sha256(b11PdfWithText())).toMatch(/^[0-9a-f]{64}$/);
  });
});
