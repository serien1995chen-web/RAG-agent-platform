import { describe, expect, it } from 'vitest';
import { ApiErrorException, createApiError } from '@kb/contracts';
import { assertImageCapability, resolveImageSources } from '../../src/shared/api/image-ingest';
import { signUploadToken } from '../../src/pages/api/core/dataset/file/presignUpload';
import type { ExtendedAppRuntime } from '../../src/runtime/bootstrap';
import type { RequestContext } from '@kb/service';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP478+AFWEXHbQSAOBoU4FwyX8rAAAAAElFTkSuQmCC',
  'base64',
);
const teamId = 'a'.repeat(24);
const datasetId = 'b'.repeat(24);
const objectKey = `dataset/${datasetId}/uploads/demo.png`;
const context: RequestContext = {
  requestId: 'req-image-ingest',
  tenant: { teamId, tmbId: 'c'.repeat(24), authType: 'internal', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
};

function token(overrides: { teamId?: string; datasetId?: string; expiresAt?: number } = {}) {
  return signUploadToken({
    kind: 'file',
    teamId: overrides.teamId ?? teamId,
    datasetId: overrides.datasetId ?? datasetId,
    bucket: 'kb-demo',
    key: objectKey,
    uploadId: '',
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
  });
}

function runtimeWith(get: (ref: { bucket: string; key: string }) => Promise<unknown>) {
  return {
    config: {
      system: { s3: { bucket: 'kb-demo' } },
      datasetRuntime: { maxImagesPerRequest: 10, maxRequestBodyBytes: 10 * 1024 * 1024 },
    },
    ports: {
      objectStore: {
        get: async (input: { ref: { bucket: string; key: string } }) => get(input.ref),
      },
    },
    imageCapability: {},
  } as unknown as ExtendedAppRuntime;
}

const okGet = async () => ({ ref: { bucket: 'kb-demo', key: objectKey }, body: PNG });

describe('image ingest source validation', () => {
  it('resolves a real fileRef to a stable 24-hex id and the detected mime/size', async () => {
    const resolved = await resolveImageSources(runtimeWith(okGet), context, datasetId, [token()]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.mimeType).toBe('image/png');
    expect(resolved[0]?.size).toBe(PNG.length);
    expect(resolved[0]?.imageId).toMatch(/^[0-9a-f]{24}$/);
  });

  it('accepts a raw key only inside dataset/<datasetId>/uploads/', async () => {
    const runtime = runtimeWith(okGet);
    await expect(
      resolveImageSources(runtime, context, datasetId, [objectKey]),
    ).resolves.toHaveLength(1);
    await expect(
      resolveImageSources(runtime, context, datasetId, ['dataset/other/uploads/x.png']),
    ).rejects.toMatchObject({ error: { code: 501061 } });
  });

  it('rejects tampered, cross-team and expired fileRef tokens', async () => {
    const runtime = runtimeWith(okGet);
    await expect(
      resolveImageSources(runtime, context, datasetId, [`${token()}x`]),
    ).rejects.toMatchObject({ error: { code: 501061 } });
    await expect(
      resolveImageSources(runtime, context, datasetId, [token({ teamId: 'd'.repeat(24) })]),
    ).rejects.toMatchObject({ error: { code: 501061 } });
    await expect(
      resolveImageSources(runtime, context, datasetId, [token({ expiresAt: Date.now() - 1000 })]),
    ).rejects.toMatchObject({ error: { code: 501011 } });
  });

  it('propagates missing objects and rejects non-image / oversized bodies', async () => {
    const missing = runtimeWith(async () => {
      throw new ApiErrorException(
        createApiError({
          code: 501015,
          requestId: 't',
          params: { objectKeyHash: 'h', bucket: 'b' },
        }),
      );
    });
    await expect(resolveImageSources(missing, context, datasetId, [token()])).rejects.toMatchObject(
      { error: { code: 501015 } },
    );

    const text = runtimeWith(async () => ({ body: Buffer.from('not an image') }));
    await expect(resolveImageSources(text, context, datasetId, [token()])).rejects.toMatchObject({
      error: { code: 501035 },
    });

    const tinyLimit = runtimeWith(okGet);
    (tinyLimit.config.datasetRuntime as { maxRequestBodyBytes: number }).maxRequestBodyBytes = 10;
    await expect(
      resolveImageSources(tinyLimit, context, datasetId, [token()]),
    ).rejects.toMatchObject({ error: { code: 501065 } });
  });

  it('returns 501010 when no image capability is configured', () => {
    const runtime = runtimeWith(okGet);
    expect(() => assertImageCapability(runtime, 'req')).not.toThrow();
    const without = { ...runtime, imageCapability: undefined } as ExtendedAppRuntime;
    expect(() => assertImageCapability(without, 'req')).toThrow(ApiErrorException);
    try {
      assertImageCapability(without, 'req');
    } catch (error) {
      expect((error as ApiErrorException).error.code).toBe(501010);
    }
  });
});
