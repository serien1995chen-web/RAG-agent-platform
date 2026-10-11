import { describe, expect, it } from 'vitest';
import { assertObjectKeyScope } from '../../sdk/storage/src/tenant-scope';

describe('P4-12 ingest tenant isolation', () => {
  it('rejects cross-team temp keys without leaking internal paths', () => {
    try {
      assertObjectKeyScope(
        { bucket: 'kb-source', key: 'temp/team-b/secret.png' },
        { teamId: 'team-a' },
      );
      throw new Error('expected-rejection');
    } catch (error) {
      expect((error as { error?: { code?: number } }).error?.code).toBe(501061);
      expect(JSON.stringify(error)).not.toContain('secret.png');
    }
  });

  it('accepts same-team temp keys and same-dataset keys', () => {
    expect(() =>
      assertObjectKeyScope(
        { bucket: 'kb-source', key: 'temp/team-a/file.png' },
        { teamId: 'team-a' },
      ),
    ).not.toThrow();
    expect(() =>
      assertObjectKeyScope(
        { bucket: 'kb-source', key: 'dataset/ds-1/file.pdf' },
        { teamId: 'team-a', datasetId: 'ds-1' },
      ),
    ).not.toThrow();
  });

  it('rejects path traversal keys', () => {
    expect(() =>
      assertObjectKeyScope(
        { bucket: 'kb-source', key: 'temp/team-a/../team-b/file' },
        { teamId: 'team-a' },
      ),
    ).toThrow();
  });
});
