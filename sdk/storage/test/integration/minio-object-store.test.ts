import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createObjectStore } from '../../src/index';

function md5Hex(body: Uint8Array): string {
  return createHash('md5').update(body).digest('hex');
}

function sha256Hex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

/** S3 multipart ETag：md5(拼接各分片 md5 原始摘要)-分片数。 */
function multipartEtag(bodies: readonly Uint8Array[]): string {
  const digests = bodies.map((body) => createHash('md5').update(body).digest());
  return `${createHash('md5').update(Buffer.concat(digests)).digest('hex')}-${bodies.length}`;
}

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

  it('uploads two parts idempotently and completes a readable object', async () => {
    const context = { teamId: 'team-a' };
    const key = `temp/team-a/${Date.now()}-complete.bin`;
    const ref = { bucket: 'kb-integration-test', key };
    const prepared = await store.prepareMultipart({ ref, parts: 2 }, context);
    const uploadId = prepared.multipartUploadId as string;
    expect(uploadId).toBeTruthy();

    // S3 要求除最后一个分片外每片至少 5MiB。
    const part1 = Buffer.alloc(5 * 1024 * 1024, 0x61);
    const part2 = Buffer.from('multipart');
    const first = await store.uploadPart(
      { ref, uploadId, partNumber: 1, body: part1, checksum: md5Hex(part1) },
      context,
    );
    expect(first).toMatchObject({ partNumber: 1, size: part1.byteLength });
    expect(first.etag).toBeTruthy();

    const repeated = await store.uploadPart(
      { ref, uploadId, partNumber: 1, body: part1, checksum: `md5:${md5Hex(part1)}` },
      context,
    );
    expect(repeated.etag).toBe(first.etag);

    const second = await store.uploadPart(
      { ref, uploadId, partNumber: 2, body: part2, checksum: `sha256:${sha256Hex(part2)}` },
      context,
    );

    const expectedEtag = multipartEtag([part1, part2]);
    const completed = await store.completeMultipart(
      { ref, uploadId, parts: [second, first], hash: expectedEtag },
      context,
    );
    expect(completed.etag).toBe(expectedEtag);
    expect(completed.size).toBe(part1.byteLength + part2.byteLength);

    const got = await store.get({ ref }, context);
    const received = Buffer.from(got.body);
    expect(received.byteLength).toBe(part1.byteLength + part2.byteLength);
    expect(received.subarray(0, 4).toString('utf8')).toBe('aaaa');
    expect(received.subarray(-9).toString('utf8')).toBe('multipart');
    await store.delete({ ref }, context);
  });

  it('rejects a part with a mismatched checksum (501060) without leaking the key', async () => {
    const context = { teamId: 'team-a' };
    const key = `temp/team-a/${Date.now()}-bad-checksum.bin`;
    const ref = { bucket: 'kb-integration-test', key };
    const prepared = await store.prepareMultipart({ ref, parts: 2 }, context);
    const uploadId = prepared.multipartUploadId as string;
    const body = Buffer.from('integrity');
    try {
      await store.uploadPart(
        { ref, uploadId, partNumber: 1, body, checksum: 'md5:deadbeef' },
        context,
      );
      throw new Error('expected checksum failure');
    } catch (error) {
      const apiError = (error as { error?: { code: number; params: Record<string, unknown> } })
        .error;
      expect(apiError?.code).toBe(501060);
      expect(JSON.stringify(apiError?.params)).not.toContain(key);
    }
    await store.abort({ ref }, context);
  });

  it('rejects a completed upload when hash does not match the response ETag (501060)', async () => {
    const context = { teamId: 'team-a' };
    const key = `temp/team-a/${Date.now()}-bad-hash.bin`;
    const ref = { bucket: 'kb-integration-test', key };
    const prepared = await store.prepareMultipart({ ref, parts: 1 }, context);
    const uploadId = prepared.multipartUploadId as string;
    const body = Buffer.from('hash-body');
    const receipt = await store.uploadPart(
      { ref, uploadId, partNumber: 1, body, checksum: md5Hex(body) },
      context,
    );
    await expect(
      store.completeMultipart(
        {
          ref,
          uploadId,
          parts: [receipt],
          hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501060 } });
    // P1：hash 校验失败必须回收已提交对象，不能留下正式对象或孤儿数据。
    await expect(store.get({ ref }, context)).rejects.toMatchObject({ error: { code: 501015 } });
  });

  it('maps integrity S3 failures (EntityTooSmall) to 501060', async () => {
    const context = { teamId: 'team-a' };
    const key = `temp/team-a/${Date.now()}-too-small.bin`;
    const ref = { bucket: 'kb-integration-test', key };
    const prepared = await store.prepareMultipart({ ref, parts: 2 }, context);
    const uploadId = prepared.multipartUploadId as string;
    // 非末分片小于 S3 最小 5MiB，complete 时 MinIO 返回 EntityTooSmall。
    const part1 = Buffer.from('tiny');
    const part2 = Buffer.from('tail');
    const first = await store.uploadPart(
      { ref, uploadId, partNumber: 1, body: part1, checksum: md5Hex(part1) },
      context,
    );
    const second = await store.uploadPart(
      { ref, uploadId, partNumber: 2, body: part2, checksum: md5Hex(part2) },
      context,
    );
    await expect(
      store.completeMultipart(
        { ref, uploadId, parts: [first, second], hash: multipartEtag([part1, part2]) },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501060 } });
    await store.abort({ ref }, context);
    await expect(store.get({ ref }, context)).rejects.toMatchObject({ error: { code: 501015 } });
  });

  it('maps integrity S3 failures (InvalidPart) to 501060', async () => {
    const context = { teamId: 'team-a' };
    const key = `temp/team-a/${Date.now()}-invalid-part.bin`;
    const ref = { bucket: 'kb-integration-test', key };
    const prepared = await store.prepareMultipart({ ref, parts: 1 }, context);
    const uploadId = prepared.multipartUploadId as string;
    const body = Buffer.from('invalid-part-body');
    const receipt = await store.uploadPart(
      { ref, uploadId, partNumber: 1, body, checksum: md5Hex(body) },
      context,
    );
    const tampered = { ...receipt, etag: '00000000000000000000000000000000' };
    await expect(
      store.completeMultipart(
        { ref, uploadId, parts: [tampered], hash: multipartEtag([body]) },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501060 } });
    await store.abort({ ref }, context);
  });

  it('leaves no residue after aborting an in-flight upload', async () => {
    const context = { teamId: 'team-a' };
    const key = `temp/team-a/${Date.now()}-aborted.bin`;
    const ref = { bucket: 'kb-integration-test', key };
    const prepared = await store.prepareMultipart({ ref, parts: 1 }, context);
    const uploadId = prepared.multipartUploadId as string;
    const body = Buffer.from('aborted');
    const receipt = await store.uploadPart(
      { ref, uploadId, partNumber: 1, body, checksum: md5Hex(body) },
      context,
    );
    const aborted = await store.abort({ ref }, context);
    expect(aborted.aborted).toBe(true);
    await expect(
      store.completeMultipart(
        { ref, uploadId, parts: [receipt], hash: multipartEtag([body]) },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501060 } });
    await expect(store.get({ ref }, context)).rejects.toBeDefined();
  });

  it('rejects cross-team multipart calls before touching the object store', async () => {
    const ref = { bucket: 'kb-integration-test', key: 'temp/team-b/other.bin' };
    const body = Buffer.from('x');
    await expect(
      store.uploadPart(
        { ref, uploadId: 'no-such-upload', partNumber: 1, body, checksum: md5Hex(body) },
        { teamId: 'team-a' },
      ),
    ).rejects.toMatchObject({ error: { code: 501061 } });
    await expect(
      store.completeMultipart(
        {
          ref,
          uploadId: 'no-such-upload',
          parts: [{ partNumber: 1, etag: 'etag', size: 1 }],
          hash: 'anything',
        },
        { teamId: 'team-a' },
      ),
    ).rejects.toMatchObject({ error: { code: 501061 } });
  });
});
