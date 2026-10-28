// @vitest-environment jsdom

import rehypeExternalLinks from 'rehype-external-links';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import { sanitizeMermaidSvg, safeMarkdownSchema } from '../../src/components/s7-markdown-renderer';

function sanitizedTree(markdown: string): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, safeMarkdownSchema)
    .use(rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] });
  return JSON.stringify(processor.runSync(processor.parse(markdown)));
}

describe('S7 Markdown citation rendering security', () => {
  it('removes script, iframe, event attributes and dangerous URLs', () => {
    const tree = sanitizedTree(
      '<script>alert(1)</script><iframe src="https://evil.invalid"></iframe><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">x</a>',
    );
    expect(tree).not.toContain('script');
    expect(tree).not.toContain('iframe');
    expect(tree).not.toContain('onerror');
    expect(tree).not.toContain('javascript:');
  });

  it('keeps GFM tables and applies safe external link attributes', () => {
    const tree = sanitizedTree(
      '| A | B |\n|---|---|\n| 1 | 2 |\n\n[link](https://example.invalid)',
    );
    expect(tree).toContain('"tagName":"table"');
    expect(tree).toContain('"target":"_blank"');
    expect(tree).toContain('"rel":["noopener","noreferrer"]');
  });

  it('sanitizes Mermaid SVG allowlists and never permits active content', () => {
    const svg = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject><div>x</div></foreignObject><a href="javascript:alert(2)"><rect width="10" height="10" onclick="alert(3)"/></a><style>*{}</style></svg>',
    );
    expect(svg).toContain('<rect');
    expect(svg).not.toContain('script');
    expect(svg).not.toContain('foreignObject');
    expect(svg).not.toContain('onload');
    expect(svg).not.toContain('onclick');
    expect(svg).not.toContain('javascript:');
    expect(svg).not.toContain('<style');
  });

  it('limits link protocols to http, https and mailto', () => {
    expect(safeMarkdownSchema.protocols?.href).toEqual(['http', 'https', 'mailto']);
  });
});
