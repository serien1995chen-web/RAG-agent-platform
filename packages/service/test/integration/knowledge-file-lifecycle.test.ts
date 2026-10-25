import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MinioKnowledgeObjectStore, knowledgeObjectKey } from '../../../../sdk/storage/src/index';
import { ObjectLifecycleService } from '../../src/modules/knowledge/application/object-lifecycle';
import { KnowledgeObjectRefRepository } from '../../src/modules/knowledge/repository/object-ref.repository';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_lifecycle_${suffix}`;
const knowledgeSpaceId = new mongoose.Types.ObjectId().toString();
const context: TenantContext = {
  workspaceId,
  memberId: `mem_lifecycle_${suffix}`,
  requestId: `req_lifecycle_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:admin'],
};

let connection: mongoose.Connection;
let repository: KnowledgeObjectRefRepository;
let objectStore: MinioKnowledgeObjectStore;
let lifecycle: ObjectLifecycleService;

async function createPending(expired: boolean): Promise<string> {
  const uploadId = new mongoose.Types.ObjectId().toString();
  const safeName = `${uploadId}.txt`;
  const finalObjectKey = knowledgeObjectKey({
    workspaceId,
    knowledgeSpaceId,
    sourceId: 'unbound',
    purpose: 'source',
    blobId: uploadId,
    safeName,
  });
  await repository.createUploadSession(
    {
      uploadId,
      workspaceId,
      knowledgeSpaceId,
      provider: 'minio',
      bucket: objectStore.bucket,
      objectKey: finalObjectKey.replace('/source/unbound/source/', '/source/unbound/pending/'),
      finalObjectKey,
      mimeType: 'text/plain',
      sizeBytes: 5,
      originalName: safeName,
      mode: 'single',
      partSizeBytes: 8388608,
      partCount: 1,
      providerUploadId: null,
      expiresAt: new Date(Date.now() + (expired ? -1000 : 3_600_000)),
    },
    context,
  );
  return uploadId;
}

async function createExpiredMultipart(): Promise<{
  uploadId: string;
  objectKey: string;
  providerUploadId: string;
}> {
  const uploadId = new mongoose.Types.ObjectId().toString();
  const safeName = `${uploadId}.txt`;
  const finalObjectKey = knowledgeObjectKey({
    workspaceId,
    knowledgeSpaceId,
    sourceId: 'unbound',
    purpose: 'source',
    blobId: uploadId,
    safeName,
  });
  const objectKey = finalObjectKey.replace('/source/unbound/source/', '/source/unbound/pending/');
  const storage = {
    workspaceId,
    knowledgeSpaceId,
    requestId: context.requestId,
    traceId: context.traceId,
  };
  const providerUploadId = await objectStore.createMultipartUpload(
    objectKey,
    'text/plain',
    {},
    storage,
  );
  await objectStore.uploadPart(objectKey, providerUploadId, 1, Buffer.from('hello'), storage);
  await repository.createUploadSession(
    {
      uploadId,
      workspaceId,
      knowledgeSpaceId,
      provider: 'minio',
      bucket: objectStore.bucket,
      objectKey,
      finalObjectKey,
      mimeType: 'text/plain',
      sizeBytes: 5,
      originalName: safeName,
      mode: 'multipart',
      partSizeBytes: 8388608,
      partCount: 1,
      providerUploadId,
      expiresAt: new Date(Date.now() - 1000),
    },
    context,
  );
  return { uploadId, objectKey, providerUploadId };
}

beforeAll(async () => {
  const mongoUri = new URL(
    process.env.KB_TEST_MONGO_URI ??
      `mongodb://127.0.0.1:27017/kb_s2_lifecycle_${suffix}?directConnection=true`,
  );
  mongoUri.searchParams.set('directConnection', 'true');
  connection = mongoose.createConnection(mongoUri.toString(), {
    serverSelectionTimeoutMS: 5_000,
  });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  const endpoint = new URL(process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000');
  objectStore = new MinioKnowledgeObjectStore({
    provider: 'minio',
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey: process.env.KB_TEST_S3_ACCESS_KEY ?? 'minioadmin',
    secretKey: process.env.KB_TEST_S3_SECRET_KEY ?? 'minioadmin',
    region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
    bucket: process.env.KB_TEST_S3_BUCKET ?? 'kb-test',
  });
  repository = new KnowledgeObjectRefRepository(connection);
  lifecycle = new ObjectLifecycleService(repository, objectStore, 500);
}, 60_000);

afterAll(async () => {
  if (connection) {
    for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
      const model = connection.models[entry.modelName];
      if (model) await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
});

describe('TEST-FILE-005-BLOCK object lifecycle', () => {
  it('TEST-FILE-005-T01 expires pending objects into deleted', async () => {
    const uploadId = await createPending(true);
    const result = await lifecycle.cleanup(context);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const ref = await repository.findObjectRef(uploadId, context);
    expect(ref?.state).toBe('deleted');
  });

  it('TEST-FILE-005-T02 never deletes an object referenced by an active Source', async () => {
    const uploadId = await createPending(true);
    const sources = connection.models.KnowledgeSource;
    await sources.create({
      workspaceId,
      knowledgeSpaceId: new mongoose.Types.ObjectId(knowledgeSpaceId),
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'file',
      name: 'active.txt',
      blobRefId: new mongoose.Types.ObjectId(uploadId),
      mimeType: 'text/plain',
      sizeBytes: 5,
      ownershipMemberId: context.memberId,
    });
    await lifecycle.cleanup(context);
    expect((await repository.findObjectRef(uploadId, context))?.state).toBe('pending');
  });

  it('TEST-FILE-005-T03 treats provider 404 as a successful deletion', async () => {
    const uploadId = await createPending(true);
    await lifecycle.cleanup(context);
    await lifecycle.cleanup(context);
    expect((await repository.findObjectRef(uploadId, context))?.state).toBe('deleted');
  });

  it('TEST-FILE-005-T08 aborts an expired multipart upload before deletion', async () => {
    const multipart = await createExpiredMultipart();
    const result = await lifecycle.cleanup(context);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect((await repository.findObjectRef(multipart.uploadId, context))?.state).toBe('deleted');
    const listError = await objectStore
      .listParts(multipart.objectKey, multipart.providerUploadId, {
        workspaceId,
        knowledgeSpaceId,
        requestId: context.requestId,
        traceId: context.traceId,
      })
      .catch((error: unknown) => error);
    expect(listError).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
  });

  it('TEST-FILE-005-T09 removes only an expired pending key from an active upload', async () => {
    const uploadId = await createPending(false);
    const ref = await repository.findObjectRef(uploadId, context);
    if (!ref?.pendingObjectKey || !ref.finalObjectKey) {
      throw new Error('upload temporary keys missing');
    }
    const storage = {
      workspaceId,
      knowledgeSpaceId,
      requestId: context.requestId,
      traceId: context.traceId,
    };
    await objectStore.putObject(
      {
        key: ref.pendingObjectKey,
        body: Buffer.from('old-url-recreated'),
        contentType: 'text/plain',
        workspaceId,
        knowledgeSpaceId,
      },
      storage,
    );
    await connection.models.KnowledgeObjectRef.updateOne(
      { workspaceId, _id: new mongoose.Types.ObjectId(uploadId) },
      {
        $set: {
          state: 'active',
          objectKey: ref.finalObjectKey,
          'upload.status': 'completed',
          'upload.finalizedAt': new Date(),
          'upload.pendingUrlExpiresAt': new Date(Date.now() - 1),
        },
      },
    );

    const result = await lifecycle.cleanup(context, new Date());
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const cleaned = await repository.findObjectRef(uploadId, context);
    expect(cleaned).toMatchObject({
      state: 'active',
      objectKey: ref.finalObjectKey,
      pendingObjectKey: null,
      pendingUrlExpiresAt: null,
    });
    const pendingError = await objectStore
      .headObject(objectStore.bucket, ref.pendingObjectKey, storage)
      .catch((error: unknown) => error);
    expect(pendingError).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
  });

  it('TEST-FILE-005-T10 removes both pending and final keys after failed activation', async () => {
    const uploadId = await createPending(true);
    const ref = await repository.findObjectRef(uploadId, context);
    if (!ref?.pendingObjectKey || !ref.finalObjectKey) {
      throw new Error('upload temporary keys missing');
    }
    const storage = {
      workspaceId,
      knowledgeSpaceId,
      requestId: context.requestId,
      traceId: context.traceId,
    };
    for (const key of [ref.pendingObjectKey, ref.finalObjectKey]) {
      await objectStore.putObject(
        {
          key,
          body: Buffer.from('leftover'),
          contentType: 'text/plain',
          workspaceId,
          knowledgeSpaceId,
        },
        storage,
      );
    }

    const result = await lifecycle.cleanup(context, new Date());
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect((await repository.findObjectRef(uploadId, context))?.state).toBe('deleted');
    for (const key of [ref.pendingObjectKey, ref.finalObjectKey]) {
      const error = await objectStore
        .headObject(objectStore.bucket, key, storage)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
      });
    }
  });
});
