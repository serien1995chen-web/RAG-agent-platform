import { describe, expect, it } from 'vitest';
import { createObjectStore } from '../../src/index';

const endpoint = process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const url = new URL(endpoint);

const store = createObjectStore({
  endPoint: url.hostname,
  port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
  useSSL: url.protocol === 'https:',
  accessKey: process.env.KB_TEST_S3_ACCESS_KEY ?? 'minioadmin',
  secretKey: process.env.KB_TEST_S3_SECRET_KEY ?? 'minioadmin',
  region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
  bucket: 'kb-integration-test',
});

describe('MinioObjectStore integration', () => {
  it('puts, gets, promotes and deletes a tenant-scoped object', async () => {
    const context = { teamId: 'team-a' };
    const key = `temp/team-a/${Date.now()}-integration.txt`;
    const body = Buffer.from('hello kb storage', 'utf8');

    const put = await store.put({ ref: { bucket: 'kb-integration-test', key }, body }, context);
    expect(put.size).toBe(body.byteLength);

    const got = await store.get({ ref: { bucket: 'kb-integration-test', key } }, context);
    expect(Buffer.from(got.body).toString('utf8')).toBe('hello kb storage');

    const promoted = await store.promote({ ref: { bucket: 'kb-integration-test', key } }, context);
    expect(promoted.ttlExpireAt).toBeNull();

    await store.delete({ ref: { bucket: 'kb-integration-test', key } }, context);
    await expect(
      store.get({ ref: { bucket: 'kb-integration-test', key } }, context),
    ).rejects.toBeDefined();
  });

  it('rejects cross-tenant access before touching the object store', async () => {
    await expect(
      store.put(
        {
          ref: { bucket: 'kb-integration-test', key: 'temp/team-b/x.txt' },
          body: new Uint8Array(),
        },
        { teamId: 'team-a' },
      ),
    ).rejects.toMatchObject({ error: { code: 501061 } });
  });

  it('prepares and aborts a multipart upload idempotently', async () => {
    const context = { teamId: 'team-a' };
    const key = `temp/team-a/${Date.now()}-multipart.bin`;

    const prepared = await store.prepareMultipart(
      { ref: { bucket: 'kb-integration-test', key }, parts: 2 },
      context,
    );
    expect(prepared.multipartUploadId).toBeTruthy();

    const aborted = await store.abort({ ref: { bucket: 'kb-integration-test', key } }, context);
    expect(aborted.aborted).toBe(true);

    const again = await store.abort({ ref: { bucket: 'kb-integration-test', key } }, context);
    expect(again.aborted).toBe(true);
  });

  it('maps a missing object to 501015 without leaking the internal key', async () => {
    const key = `temp/team-a/${Date.now()}-missing.txt`;
    try {
      await store.get({ ref: { bucket: 'kb-integration-test', key } }, { teamId: 'team-a' });
      throw new Error('expected missing object error');
    } catch (error) {
      const apiError = (error as { error?: { code: number; params: Record<string, unknown> } })
        .error;
      expect(apiError?.code).toBe(501015);
      expect(JSON.stringify(apiError?.params)).not.toContain(`${key}`);
    }
  });
});
