import { describe, expect, it } from 'vitest';
import { assertObjectKeyScope, objectKeyHash } from '../../sdk/storage/src/index';

/** TEST-TEN-API-001 跨团队/跨 Dataset 对象访问拒绝。 */
describe('TEST-TEN-API-001 ingest tenant isolation', () => {
  it('rejects cross-team temp keys with 501061', () => {
    expect(() =>
      assertObjectKeyScope(
        { bucket: 'kb', key: 'temp/0000000000000000000000ff/a.png' },
        { teamId: '000000000000000000000001' },
      ),
    ).toThrowError(expect.objectContaining({ error: expect.objectContaining({ code: 501061 }) }));
  });

  it('rejects dataset keys from another dataset with 501061 and does not leak the key', () => {
    try {
      assertObjectKeyScope(
        { bucket: 'kb', key: 'dataset/0000000000000000000000d2/uploads/x.md' },
        { teamId: '000000000000000000000001', datasetId: '0000000000000000000000d1' },
      );
      throw new Error('expected scope rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const apiError = error as { error?: { code: number; params: Record<string, unknown> } };
      expect(apiError.error?.code).toBe(501061);
      expect(apiError.error?.params.fileId).toBe(
        objectKeyHash('dataset/0000000000000000000000d2/uploads/x.md'),
      );
    }
  });

  it('accepts a dataset key scoped to the authorized dataset', () => {
    expect(() =>
      assertObjectKeyScope(
        { bucket: 'kb', key: 'dataset/0000000000000000000000d1/uploads/x.md' },
        { teamId: '000000000000000000000001', datasetId: '0000000000000000000000d1' },
      ),
    ).not.toThrow();
  });
});
