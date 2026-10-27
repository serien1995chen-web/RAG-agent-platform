import { describe, expect, it } from 'vitest';
import {
  parsePdfWithLiteParse,
  parseWithLiteParse,
  type LiteParseLoader,
  type ParseHandlerContext,
} from '../../src/index';
import { pdfWithText } from '../../../../test/fixtures/s5/generate-fixtures';

function context(bytes: Uint8Array): ParseHandlerContext {
  return {
    request: {
      workspaceId: 'ws-parse',
      knowledgeSpaceId: 'space-parse',
      sourceId: 'source-parse',
      fileRef: 'fixture.pdf',
      extension: 'pdf',
      mimeType: 'application/pdf',
      timeoutMs: 30_000,
    },
    bytes,
    mimeType: 'application/pdf',
  };
}

function loaderWithBehavior(behavior: 'throw' | 'throw-content'): LiteParseLoader {
  return async () => {
    if (behavior === 'throw') throw new Error('wasm_load_failed');
    return {
      LiteParse: class {
        constructor(_config: Record<string, unknown>) {}

        async parse(_data: Uint8Array): Promise<unknown> {
          throw new Error('corrupt pdf content');
        }

        free(): void {}
      },
    };
  };
}

describe('TEST-PARSE-001-BLOCK LiteParse loading and fallback', () => {
  it('uses the real LiteParse package for a deterministic PDF', async () => {
    const result = await parsePdfWithLiteParse(context(pdfWithText('LiteParse real')));
    expect(result.parserVersion).toBe('liteparse@2.0.8');
    expect(result.rawText).toContain('LiteParse real');
    expect(result.pages[0]).toMatchObject({ pageNumber: 1 });
    expect(result.assets).toEqual([]);
    expect(result.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.configHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('falls back to PDF.js only when LiteParse load/init fails', async () => {
    const result = await parseWithLiteParse(context(pdfWithText('PDF.js fallback')), {
      loader: loaderWithBehavior('throw'),
      config: { fallbackPdfJsOnWasmLoadError: true },
    });
    expect(result.rawText).toContain('PDF.js fallback');
    expect(result.parserVersion).toContain('pdfjs@4.10.38');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'liteparse_load_fallback' }),
    );
  });

  it('does not use PDF.js for corrupt PDF content', async () => {
    await expect(
      parseWithLiteParse(context(pdfWithText('corrupt content')), {
        loader: loaderWithBehavior('throw-content'),
      }),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
        },
      },
    });
  });

  it('force-disables OCR and rejects invalid or unknown config', async () => {
    await expect(
      parseWithLiteParse(context(pdfWithText()), {
        config: { ocrEnabled: true as never },
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    await expect(
      parseWithLiteParse(context(pdfWithText()), {
        config: { maxPages: 0 },
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    await expect(
      parseWithLiteParse(context(pdfWithText()), {
        config: { fallbackPdfJsOnWasmLoadError: false },
        loader: loaderWithBehavior('throw'),
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' } },
    });
  });
});
