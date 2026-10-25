import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MinioKnowledgeObjectStore } from '../../src/providers/minio';
import { knowledgeObjectKey, type KnowledgeObjectContext } from '../../src/object-store-contract';

const endpoint = new URL(process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000');
const bucket = process.env.KB_TEST_S3_BUCKET ?? 'kb-test';
const context: KnowledgeObjectContext = {
  workspaceId: `ws_s2_${randomUUID().slice(0, 8)}`,
  knowledgeSpaceId: `space_s2_${randomUUID().slice(0, 8)}`,
  requestId: 'request-minio-integration',
  traceId: 'trace-minio-integration',
};
const cleanupKeys = new Set<string>();

const store = new MinioKnowledgeObjectStore({
  provider: 'minio',
  endPoint: endpoint.hostname,
  port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
  useSSL: endpoint.protocol === 'https:',
  accessKey: process.env.KB_TEST_S3_ACCESS_KEY ?? 'minioadmin',
  secretKey: process.env.KB_TEST_S3_SECRET_KEY ?? 'minioadmin',
  region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
  bucket,
  credentialRefs: ['env:KB_TEST_S3_ACCESS_KEY', 'env:KB_TEST_S3_SECRET_KEY'],
});

function key(name: string): string {
  const resolved = knowledgeObjectKey({
    workspaceId: context.workspaceId,
    knowledgeSpaceId: context.knowledgeSpaceId,
    sourceId: 'source_minio',
    purpose: 'source',
    blobId: randomUUID(),
    safeName: name,
  });
  cleanupKeys.add(resolved);
  return resolved;
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  await store.ensureBucket(bucket, context);
});

afterAll(async () => {
  for (const objectKey of cleanupKeys) {
    await store.deleteObject(objectKey, context);
  }
});

describe('TEST-FILE-002-BLOCK MinIO real stack', () => {
  it('TEST-FILE-002-P06 supports single PUT and presigned GET', async () => {
    const objectKey = key('single.txt');
    const body = Buffer.from('knowledge-object-storage');
    const stored = await store.putObject(
      {
        key: objectKey,
        body,
        sizeBytes: body.byteLength,
        contentType: 'text/plain',
        workspaceId: context.workspaceId,
        knowledgeSpaceId: context.knowledgeSpaceId,
      },
      context,
    );
    expect(stored.provider).toBe('minio');
    expect(stored.size).toBe(body.byteLength);
    expect(stored.sha256).toBe(createHash('sha256').update(body).digest('hex'));

    const signed = await store.presignGet(objectKey, null, 300, context);
    const response = await fetch(signed.url);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
  });

  it('TEST-FILE-002-P07 completes two 8 MiB parts with matching HEAD', async () => {
    const objectKey = key('multipart.bin');
    const uploadId = await store.createMultipartUpload(
      objectKey,
      'application/octet-stream',
      {},
      context,
    );
    const first = Buffer.alloc(8 * 1024 * 1024, 'a');
    const second = Buffer.alloc(8 * 1024 * 1024, 'b');
    const partOne = await store.uploadPart(objectKey, uploadId, 1, first, context);
    const partTwo = await store.uploadPart(objectKey, uploadId, 2, second, context);
    const listed = await store.listParts(objectKey, uploadId, context);
    expect(listed.map((part) => part.partNumber)).toEqual([1, 2]);
    const completed = await store.completeMultipartUpload(
      objectKey,
      uploadId,
      [partOne, partTwo],
      context,
    );
    const head = await store.headObject(bucket, objectKey, context);
    expect(completed.sizeBytes).toBe(first.byteLength + second.byteLength);
    expect(head.size).toBe(first.byteLength + second.byteLength);
    expect(head.etag).toBe(completed.etag);
  });

  it('TEST-FILE-002-P08 treats abort and repeated delete 404 as success', async () => {
    const objectKey = key('abort.bin');
    const uploadId = await store.createMultipartUpload(
      objectKey,
      'application/octet-stream',
      {},
      context,
    );
    await expect(store.abortMultipartUpload(objectKey, uploadId, context)).resolves.toEqual({
      aborted: true,
    });
    await expect(store.abortMultipartUpload(objectKey, uploadId, context)).resolves.toEqual({
      aborted: true,
    });
    await store.deleteObject(objectKey, context);
    await expect(store.deleteObject(objectKey, context)).resolves.toEqual({ deleted: true });
  });

  it('TEST-FILE-002-P09 returns exactly bytes=10-19', async () => {
    const objectKey = key('range.txt');
    const body = Buffer.from('0123456789abcdefghij', 'utf8');
    await store.putObject(
      {
        key: objectKey,
        body,
        sizeBytes: body.byteLength,
        contentType: 'text/plain',
        workspaceId: context.workspaceId,
        knowledgeSpaceId: context.knowledgeSpaceId,
      },
      context,
    );
    const result = await store.getObject(bucket, objectKey, 'bytes=10-19', context);
    expect(result.contentRange).toBe(`bytes 10-19/${body.byteLength}`);
    expect(await collect(result.body)).toEqual(body.subarray(10, 20));
  });
});
