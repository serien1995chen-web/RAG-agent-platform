import { describe, expect, it } from 'vitest';
import { assertObjectKeyScope } from '../../src/index';

describe('object key tenant scope (10.9)', () => {
  it('accepts temp/image keys only for the owning team', () => {
    expect(() =>
      assertObjectKeyScope({ bucket: 'b', key: 'temp/team-a/file.png' }, { teamId: 'team-a' }),
    ).not.toThrow();
    expect(() =>
      assertObjectKeyScope({ bucket: 'b', key: 'temp/team-b/file.png' }, { teamId: 'team-a' }),
    ).toThrowError(/501061/);
  });

  it('accepts dataset keys only for the owning dataset', () => {
    expect(() =>
      assertObjectKeyScope(
        { bucket: 'b', key: 'dataset/ds-1/file.pdf' },
        { teamId: 'team-a', datasetId: 'ds-1' },
      ),
    ).not.toThrow();
    expect(() =>
      assertObjectKeyScope(
        { bucket: 'b', key: 'dataset/ds-2/file.pdf' },
        { teamId: 'team-a', datasetId: 'ds-1' },
      ),
    ).toThrowError(/501061/);
  });

  it('rejects traversal and unregistered prefixes', () => {
    expect(() =>
      assertObjectKeyScope({ bucket: 'b', key: 'temp/team-a/../x' }, { teamId: 'team-a' }),
    ).toThrow();
    expect(() =>
      assertObjectKeyScope({ bucket: 'b', key: 'public/team-a/x' }, { teamId: 'team-a' }),
    ).toThrowError(/501061/);
  });
});
