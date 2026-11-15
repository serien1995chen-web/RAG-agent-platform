import { describe, expect, it } from 'vitest';
import { createDefaultDocumentParser } from '../../src/index';
import { parseHtml } from '../../src/parsers/html';
import type { ParseHandlerContext, ParseRequest } from '../../src/format-registry';

const request: ParseRequest = {
  workspaceId: 'ws_b10_parse',
  knowledgeSpaceId: 'space_b10_parse',
  sourceId: 'source_b10_parse',
  fileRef: 'https://public.example.test/docs/start',
  extension: 'html',
  mimeType: 'text/html',
  timeoutMs: 30_000,
};

function urlContext(
  html: string,
  overrides: { selector?: string; baseUrl?: string } = {},
): ParseHandlerContext {
  return {
    request: {
      ...request,
      fileRef: overrides.baseUrl ?? request.fileRef,
    },
    bytes: Buffer.from(html),
    mimeType: 'text/html',
    selector: overrides.selector ?? 'body',
    baseUrl: overrides.baseUrl ?? request.fileRef,
  } as ParseHandlerContext;
}

describe('L1-B10-ING-003-P02/P03 URL HTML extraction', () => {
  it('L1-B10-ING-003-P02/P03 applies selector, noise cleanup and absolute links', async () => {
    const html = `<!doctype html>
      <html>
        <head><title>Fallback title</title></head>
        <body>
          <nav>outside navigation</nav>
          <main id="article">
            <h1>Selected heading</h1>
            <script>outside()</script>
            <style>.hidden{display:none}</style>
            <p>Selected body <i>decorative icon</i></p>
            <a href="guide/next">relative link</a>
            <a href="./asset.png"><img src="../images/cover.png" alt="Cover"></a>
            <a href=" "></a>
          </main>
          <aside>outside sidebar</aside>
        </body>
      </html>`;

    const result = await parseHtml(
      urlContext(html, {
        selector: 'main#article',
        baseUrl: 'https://public.example.test/docs/start',
      }),
    );

    expect(result.rawText).toContain('Selected heading');
    expect(result.rawText).toContain('Selected body');
    expect(result.rawText).not.toContain('outside navigation');
    expect(result.rawText).not.toContain('outside sidebar');
    expect(result.rawText).not.toContain('outside()');
    expect(result.rawText).not.toContain('decorative icon');
    expect(result.rawText).toContain('https://public.example.test/docs/guide/next');
    expect(result.rawText).toContain('https://public.example.test/images/cover.png');
    expect(result.imageRefs).toContain('https://public.example.test/images/cover.png');
  });

  it('L1-B10-ING-003-N02 defaults blank selector to body and rejects empty selected content', async () => {
    const defaultResult = await parseHtml(
      urlContext('<html><body><main>Visible</main><aside>Aside</aside></body></html>', {
        selector: '',
      }),
    );
    expect(defaultResult.rawText).toContain('Visible');
    expect(defaultResult.rawText).toContain('Aside');

    for (const scenario of [
      { selector: 'main', html: '<html><body><aside>only aside</aside></body></html>' },
      { selector: 'main', html: '<html><body><main><script>only()</script></main></body></html>' },
    ]) {
      await expect(parseHtml(urlContext(scenario.html, scenario))).rejects.toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
      });
    }
  });

  it('L1-B10-ING-003-N03 rejects structurally damaged URL HTML', async () => {
    await expect(
      parseHtml(
        urlContext('<html><body><main><p>BROKEN_FIXTURE_TEXT', {
          selector: 'main',
        }),
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
  });

  it('L1-B10-ING-003-P03 keeps h1 content and Markdown deterministic', async () => {
    const first = await parseHtml(
      urlContext('<html><body><h1>Only heading</h1><p>Body</p></body></html>', {
        baseUrl: 'https://public.example.test/path',
      }),
    );
    const second = await parseHtml(
      urlContext('<html><body><h1>Only heading</h1><p>Body</p></body></html>', {
        baseUrl: 'https://public.example.test/path',
      }),
    );
    expect(first.rawText).toContain('# Only heading');
    expect(first.contentHash).toBe(second.contentHash);
  });

  it('L1-B10-ING-003-S03 passes URL selector context through the formal parser port', async () => {
    const result = await createDefaultDocumentParser().parse({
      ...request,
      selector: 'main',
      baseUrl: 'https://public.example.test/docs/start',
      bytes: Buffer.from(
        '<html><body><main><h1>Formal</h1><a href="next">Next</a></main><aside>Outside</aside></body></html>',
      ),
    });
    expect(result.rawText).toContain('Formal');
    expect(result.rawText).toContain('https://public.example.test/docs/next');
    expect(result.rawText).not.toContain('Outside');
  });
});
