import type { Client } from 'minio';
import { describe, expect, it, vi } from 'vitest';
import { assertObjectKeyScope, objectKeyHash, presignObjectUrl } from '../../src/index';

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

  it('rejects traversal, absolute paths, backslashes and unregistered prefixes', () => {
    expect(() =>
      assertObjectKeyScope({ bucket: 'b', key: 'temp/team-a/../x' }, { teamId: 'team-a' }),
    ).toThrow();
    expect(() =>
      assertObjectKeyScope({ bucket: 'b', key: '/temp/team-a/x' }, { teamId: 'team-a' }),
    ).toThrowError(/501061/);
    expect(() =>
      assertObjectKeyScope({ bucket: 'b', key: 'temp\\team-a\\x' }, { teamId: 'team-a' }),
    ).toThrowError(/501061/);
    expect(() =>
      assertObjectKeyScope({ bucket: 'b', key: 'public/team-a/x' }, { teamId: 'team-a' }),
    ).toThrowError(/501061/);
  });

  it('never leaks the internal key in scope errors', () => {
    const key = 'temp/team-b/internal-secret-file.png';
    try {
      assertObjectKeyScope({ bucket: 'b', key }, { teamId: 'team-a' });
      throw new Error('expected scope rejection');
    } catch (error) {
      const apiError = (error as { error?: { code: number; params: Record<string, unknown> } })
        .error;
      expect(apiError?.code).toBe(501061);
      expect(apiError?.params.fileId).toBe(objectKeyHash(key));
      expect(JSON.stringify(apiError?.params)).not.toContain('internal-secret-file');
    }
  });

  it('rejects presign for out-of-scope refs without touching the client', async () => {
    const presignedGetObject = vi.fn();
    const client = { presignedGetObject } as unknown as Client;

    await expect(
      presignObjectUrl(
        client,
        { bucket: 'b', key: 'temp/team-b/file.png' },
        { teamId: 'team-a' },
        60,
      ),
    ).rejects.toMatchObject({ error: { code: 501061 } });
    expect(presignedGetObject).not.toHaveBeenCalled();
  });

  it('presigns in-scope refs with the caller-provided expiry', async () => {
    const presignedGetObject = vi.fn().mockResolvedValue('https://example.test/signed');
    const client = { presignedGetObject } as unknown as Client;

    const url = await presignObjectUrl(
      client,
      { bucket: 'b', key: 'image/team-a/file.png' },
      { teamId: 'team-a' },
      120,
    );

    expect(url).toBe('https://example.test/signed');
    expect(presignedGetObject).toHaveBeenCalledWith('b', 'image/team-a/file.png', 120);
  });
});
