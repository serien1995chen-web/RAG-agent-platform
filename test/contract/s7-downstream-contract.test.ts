import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const source = readFileSync(
  resolve(root, 'packages/web/src/client/s7-downstream-knowledge-client.ts'),
  'utf8',
);

describe('TEST-DOWN-001...003 S7 downstream static contract', () => {
  it('imports contracts only and uses the downstream path allowlist', () => {
    expect(source).toContain("from '@kb/contracts'");
    expect(source).not.toMatch(/@kb\/(?:service|dal|search)/);
    expect(source).not.toMatch(/mongoose|mongodb|ioredis|bullmq|pgvector/);
    expect(source).not.toContain('objectKey');
    expect(source).toContain('/v1/knowledge/search/semantic');
    expect(source).toContain('/v1/knowledge/search/full-text');
    expect(source).toContain('/v1/knowledge/search/hybrid');
    expect(source).toContain('/v1/knowledge/search/multi-space');
    expect(source).toContain('/v1/knowledge/citations/');
  });

  it('does not mark DOWN capabilities as closed in source', () => {
    expect(source).not.toContain('DOWN-001');
    expect(source).not.toContain('closed');
  });
});
