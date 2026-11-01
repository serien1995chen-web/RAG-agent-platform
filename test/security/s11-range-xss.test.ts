// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { parseSingleRange } from '../../sdk/storage/src/object-store-contract';
import {
  safeMarkdownSchema,
  sanitizeMermaidSvg,
} from '../../packages/web/src/components/s7-markdown-renderer';

describe('TEST-X-SECURITY-RANGE and TEST-X-SECURITY-XSS', () => {
  it('accepts one exact range and rejects suffix, multiple, invalid and out-of-bounds forms', () => {
    const context = {
      workspaceId: 'ws_s11_security',
      knowledgeSpaceId: 'space_s11_security',
      requestId: 'req_s11_security',
      traceId: 'trace_s11_security',
    };
    expect(parseSingleRange('bytes=0-3', 16, context)).toEqual({
      start: 0,
      end: 3,
      header: 'bytes=0-3',
    });
    for (const range of ['bytes=-3', 'bytes=0-1,3-4', 'items=0-1', 'bytes=8-4', 'bytes=0-16']) {
      expect(() => parseSingleRange(range, 16, context), range).toThrow();
    }
  });

  it('allows only http, https and mailto link protocols', () => {
    expect(safeMarkdownSchema.protocols?.href).toEqual(['http', 'https', 'mailto']);
  });

  it('sanitizes Mermaid SVG active content while preserving safe shapes', () => {
    const svg = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject><div>x</div></foreignObject><a href="javascript:alert(2)"><rect width="10" height="10" onclick="alert(3)"/></a><style>*{}</style></svg>',
    );
    expect(svg).toContain('<rect');
    expect(svg).not.toContain('script');
    expect(svg).not.toContain('foreignObject');
    expect(svg).not.toContain('onload');
    expect(svg).not.toContain('onclick');
    expect(svg).not.toContain('javascript:');
  });
});
