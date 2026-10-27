import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDefaultDocumentParser,
  detectAnyDocExtension,
  type DocumentParseContext,
} from '../../src/index';
import {
  S5_FIXTURES,
  docxBytes,
  hostileZip,
  fixtureHashes,
  pdfWithText,
} from '../../../../test/fixtures/s5/generate-fixtures';

function request(extension: string, bytes: Uint8Array, mimeType?: string): DocumentParseContext {
  return {
    workspaceId: 'ws-parse-matrix',
    knowledgeSpaceId: 'space-parse-matrix',
    sourceId: 'source-parse-matrix',
    fileRef: `fixture.${extension}`,
    extension,
    ...(mimeType ? { mimeType } : {}),
    timeoutMs: 60_000,
    bytes,
  };
}

const parser = createDefaultDocumentParser();
const manifest = JSON.parse(
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

describe('TEST-PARSE-001-BLOCK ten-format parse matrix', () => {
  it('keeps deterministic fixture hashes bound to the manifest', () => {
    const hashes = fixtureHashes();
    for (const [name, hash] of Object.entries(hashes)) {
      expect(manifest.fixtures[name]?.sha256, name).toBe(hash);
    }
  });

  it('parses TXT, MD, HTML, PDF, DOCX, PPTX, XLSX, CSV, EPUB and OFD', async () => {
    const cases = [
      ['txt', S5_FIXTURES.text],
      ['md', S5_FIXTURES.markdown],
      ['html', S5_FIXTURES.html],
      ['pdf', pdfWithText()],
      ['docx', S5_FIXTURES.docx],
      ['pptx', S5_FIXTURES.pptx],
      ['xlsx', S5_FIXTURES.xlsx],
      ['csv', S5_FIXTURES.csv],
      ['epub', S5_FIXTURES.epub],
      ['ofd', S5_FIXTURES.ofd],
    ] as const;
    for (const [extension, value] of cases) {
      const bytes = typeof value === 'string' ? Buffer.from(value) : value;
      const result = await parser.parse(request(extension, bytes));
      expect(result.rawText.length, extension).toBeGreaterThan(0);
      expect(Array.isArray(result.pages), extension).toBe(true);
      expect(Array.isArray(result.assets), extension).toBe(true);
      expect(Array.isArray(result.diagnostics), extension).toBe(true);
      expect(result.parserVersion, extension).toBeTruthy();
      expect(result.configHash, extension).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    const ofd = await parser.parse(request('ofd', S5_FIXTURES.ofd));
    expect(ofd.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(ofd.assets).toHaveLength(1);
    expect(ofd.assets[0]?.objectRefId).toBeUndefined();
    expect(ofd.assets[0]?.bytes).toBeInstanceOf(Uint8Array);
  });

  it('routes controlled anydoc magic to specific parsers and rejects unknown bytes', async () => {
    const anydocPdf = request('anydoc', pdfWithText('AnyDoc PDF'), 'application/x-anydoc');
    const pdfResult = await parser.parse(anydocPdf);
    expect(pdfResult.format).toBe('pdf');
    expect(pdfResult.rawText).toContain('AnyDoc PDF');

    await expect(detectAnyDocExtension(request('anydoc', docxBytes()), docxBytes())).resolves.toBe(
      'docx',
    );
    await expect(
      detectAnyDocExtension(
        request('anydoc', Buffer.from('plain anydoc input'), 'application/x-anydoc'),
        Buffer.from('plain anydoc input'),
      ),
    ).resolves.toBe('txt');
    await expect(
      parser.parse(request('anydoc', Buffer.from([0, 1, 2, 3, 4]), 'application/x-anydoc')),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
  });

  it('rejects hostile OFD archives and damaged PDFs without empty success', async () => {
    await expect(
      parser.parse(request('ofd', hostileZip(), 'application/ofd')),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
    await expect(
      parser.parse(request('pdf', Buffer.from('%PDF-1.7\nnot a valid pdf'), 'application/pdf')),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
  });
});
