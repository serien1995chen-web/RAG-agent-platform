import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createKnowledgeError } from '@kb/contracts';
import { FileTicketService, MinioKnowledgeObjectStore } from '../../../../sdk/storage/src/index';
import { KnowledgeArchiveWorker } from '../../../../projects/app/src/runtime/archive-worker';
import { FileApplication } from '../../src/modules/knowledge/application/file.application';
import { SourceFileApplication } from '../../src/modules/knowledge/application/source-preview';
import type {
  AccessPort,
  ArchiveSafetyPort,
  CatalogPort,
  JobPort,
} from '../../src/modules/knowledge/application/ports';
import { KnowledgeArchiveRepository } from '../../src/modules/knowledge/repository/archive.repository';
import { KnowledgeObjectRefRepository } from '../../src/modules/knowledge/repository/object-ref.repository';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import type { KnowledgeRuntimeConfig } from '../../src/shared/config/knowledge-runtime-config';
import { knowledgeObjectKey } from '../../../../sdk/storage/src/object-store-contract';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_archive_${suffix}`;
const knowledgeSpaceId = new mongoose.Types.ObjectId().toString();
const context: TenantContext = {
  workspaceId,
  memberId: `mem_archive_${suffix}`,
  requestId: `req_archive_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
};

let connection: mongoose.Connection;
let objectStore: MinioKnowledgeObjectStore;
let objectRefs: KnowledgeObjectRefRepository;
let files: FileApplication;
let jobs: KnowledgeArchiveRepository;
let sourceId: string;
const createdObjects = new Set<string>();

const catalog = {
  async getSpace(id: string) {
    return { id };
  },
} as unknown as CatalogPort;
const access = {
  async assertPermission() {
    return { allowed: true };
  },
} as unknown as AccessPort;

function runtimeConfig(): KnowledgeRuntimeConfig {
  return {
    s3: {
      endpoint: process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
      bucket: objectStore.bucket,
      region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
      accessKeyRef: 'env:KB_TEST_S3_ACCESS_KEY',
      secretKeyRef: 'env:KB_TEST_S3_SECRET_KEY',
      credentialRefs: ['env:KB_TEST_S3_ACCESS_KEY', 'env:KB_TEST_S3_SECRET_KEY'],
    },
  } as unknown as KnowledgeRuntimeConfig;
}

async function createSource(body: Buffer, name: string) {
  const session = await files.init(
    {
      knowledgeSpaceId,
      name,
      mimeType: 'text/plain',
      sizeBytes: body.byteLength,
    },
    context,
  );
  const ref = await objectRefs.findObjectRef(session.uploadId, context);
  if (!ref) throw new Error('upload object ref missing');
  createdObjects.add(ref.objectKey);
  const parts: Array<{ partNumber: number; etag: string }> = [];
  if (session.mode === 'single') {
    const presigned = await files.presign(session.uploadId, { partNumbers: [1] }, context);
    const upload = await fetch(presigned.uploads[0]!.url, {
      method: 'PUT',
      headers: presigned.uploads[0]!.headers,
      body,
    });
    expect(upload.status).toBe(200);
  } else {
    for (let partNumber = 1; partNumber <= session.partCount; partNumber += 1) {
      const start = (partNumber - 1) * session.partSizeBytes;
      const part = await files.uploadPart(
        session.uploadId,
        partNumber,
        body.subarray(start, Math.min(start + session.partSizeBytes, body.byteLength)),
        context,
      );
      parts.push(part);
    }
  }
  const completed = await files.complete({ uploadId: session.uploadId, parts }, context);
  const source = await connection.models.KnowledgeSource.create({
    workspaceId,
    knowledgeSpaceId: new mongoose.Types.ObjectId(knowledgeSpaceId),
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    kind: 'file',
    name,
    blobRefId: new mongoose.Types.ObjectId(completed.blobId),
    mimeType: 'text/plain',
    sizeBytes: body.byteLength,
    ownershipMemberId: context.memberId,
  });
  await connection.models.KnowledgeObjectRef.updateOne(
    { workspaceId, _id: new mongoose.Types.ObjectId(completed.blobId) },
    { $set: { sourceId: source._id } },
  );
  return { sourceId: String(source._id), blobId: completed.blobId };
}

class FailingDeleteStore extends MinioKnowledgeObjectStore {
  override async deleteObject(): Promise<{ deleted: boolean }> {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { reason: 'injected_delete_failure' },
    });
  }
}

beforeAll(async () => {
  const mongoUri = new URL(
    process.env.KB_TEST_MONGO_URI ??
      `mongodb://127.0.0.1:27017/kb_s2_archive_${suffix}?directConnection=true`,
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
  objectRefs = new KnowledgeObjectRefRepository(connection);
  jobs = new KnowledgeArchiveRepository(connection);
  files = new FileApplication(
    objectRefs,
    objectStore,
    catalog,
    access,
    new FileTicketService('archive-file-ticket-secret-at-least-32-bytes', 'http://127.0.0.1:3010'),
  );
}, 60_000);

afterAll(async () => {
  for (const key of createdObjects) {
    await objectStore
      .deleteObject(key, {
        workspaceId: context.workspaceId,
        knowledgeSpaceId,
        requestId: context.requestId,
        traceId: context.traceId,
      })
      .catch(() => undefined);
  }
  if (connection) {
    for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
      const model = connection.models[entry.modelName];
      if (model) await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
});

describe('TEST-FILE-004-BLOCK source archive worker', () => {
  it('builds a real ZIP ObjectRef and records the export result', async () => {
    const body = Buffer.from('archive source content');
    const session = await files.init(
      {
        knowledgeSpaceId,
        name: 'archive.txt',
        mimeType: 'text/plain',
        sizeBytes: body.byteLength,
      },
      context,
    );
    const refBefore = await objectRefs.findObjectRef(session.uploadId, context);
    if (!refBefore) throw new Error('upload object ref missing');
    createdObjects.add(refBefore.objectKey);
    const presigned = await files.presign(session.uploadId, { partNumbers: [1] }, context);
    const uploadResponse = await fetch(presigned.uploads[0]!.url, {
      method: 'PUT',
      headers: presigned.uploads[0]!.headers,
      body,
    });
    expect(uploadResponse.status).toBe(200);
    const completed = await files.complete({ uploadId: session.uploadId, parts: [] }, context);
    const source = await connection.models.KnowledgeSource.create({
      workspaceId,
      knowledgeSpaceId: new mongoose.Types.ObjectId(knowledgeSpaceId),
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'file',
      name: 'archive.txt',
      blobRefId: new mongoose.Types.ObjectId(completed.blobId),
      mimeType: 'text/plain',
      sizeBytes: body.byteLength,
      ownershipMemberId: context.memberId,
    });
    sourceId = String(source._id);
    await connection.models.KnowledgeObjectRef.updateOne(
      { workspaceId, _id: new mongoose.Types.ObjectId(completed.blobId) },
      { $set: { sourceId: source._id } },
    );
    const job = await jobs.createExportJob(
      {
        spaceId: knowledgeSpaceId,
        sourceIds: [sourceId],
        idempotencyKey: `archive-${suffix}`,
      },
      context,
    );
    const config = {
      s3: {
        endpoint: process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
        bucket: objectStore.bucket,
        region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
        accessKeyRef: 'env:KB_TEST_S3_ACCESS_KEY',
        secretKeyRef: 'env:KB_TEST_S3_SECRET_KEY',
        credentialRefs: ['env:KB_TEST_S3_ACCESS_KEY', 'env:KB_TEST_S3_SECRET_KEY'],
      },
    } as unknown as KnowledgeRuntimeConfig;
    const worker = new KnowledgeArchiveWorker(
      connection,
      config,
      `archive-worker-${suffix}`,
      undefined,
      objectStore,
    );
    await worker.runOnce();
    const succeeded = await jobs.get(String(job.jobId), context);
    expect(succeeded.status).toBe('succeeded');
    const result = succeeded.result as Record<string, unknown>;
    expect(typeof result.objectBlobRefId).toBe('string');
    const artifact = await objectRefs.findObjectRef(String(result.objectBlobRefId), context);
    expect(artifact?.purpose).toBe('export');
    expect(artifact?.state).toBe('active');
    if (!artifact) throw new Error('archive artifact missing');
    const object = await objectStore.getObject(artifact.bucket, artifact.objectKey, null, {
      ...context,
      knowledgeSpaceId,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
    const zip = Buffer.concat(chunks);
    expect(zip.subarray(0, 2).toString('ascii')).toBe('PK');
    expect(zip.byteLength).toBeGreaterThan(body.byteLength);
    await objectStore.deleteObject(artifact.objectKey, { ...context, knowledgeSpaceId });
  });

  it('TEST-FILE-004-A13/A14 fails a real compression bomb and leaves no active artifact', async () => {
    const source = await createSource(Buffer.alloc(17 * 1024 * 1024), 'compression-bomb.txt');
    const job = await jobs.createExportJob(
      {
        spaceId: knowledgeSpaceId,
        sourceIds: [source.sourceId],
        idempotencyKey: `archive-bomb-${suffix}`,
      },
      context,
    );
    const worker = new KnowledgeArchiveWorker(
      connection,
      runtimeConfig(),
      `archive-bomb-worker-${suffix}`,
      undefined,
      objectStore,
    );
    await worker.runOnce();

    const failed = await jobs.get(String(job.jobId), context);
    expect(failed.status).toBe('failed');
    expect((failed.error as { code?: string }).code).toBe('KNOWLEDGE_UNSUPPORTED_CONTENT');
    const blobId = createHash('sha1')
      .update(`archive:${String(job.jobId)}`)
      .digest('hex')
      .slice(0, 24);
    expect((await objectRefs.findObjectRef(blobId, context))?.state).toBe('deleted');
    expect(
      await connection.models.KnowledgeObjectRef.countDocuments({
        workspaceId,
        purpose: 'export',
        state: 'active',
        _id: new mongoose.Types.ObjectId(blobId),
      }),
    ).toBe(0);
  });

  it('TEST-FILE-004-A15 keeps a deleting ref when unsafe artifact cleanup fails', async () => {
    const job = await jobs.createExportJob(
      {
        spaceId: knowledgeSpaceId,
        sourceIds: [sourceId],
        idempotencyKey: `archive-cleanup-failure-${suffix}`,
      },
      context,
    );
    const unsafeInspector: ArchiveSafetyPort = {
      validateEntryPath() {
        return { safe: true };
      },
      async inspect() {
        return {
          archive: true,
          safe: false,
          status: 'unsupported',
          reason: 'archive_structure_invalid',
        };
      },
    };
    const endpoint = new URL(process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000');
    const failingStore = new FailingDeleteStore({
      provider: 'minio',
      endPoint: endpoint.hostname,
      port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
      useSSL: endpoint.protocol === 'https:',
      accessKey: process.env.KB_TEST_S3_ACCESS_KEY ?? 'minioadmin',
      secretKey: process.env.KB_TEST_S3_SECRET_KEY ?? 'minioadmin',
      region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
      bucket: objectStore.bucket,
    });
    const worker = new KnowledgeArchiveWorker(
      connection,
      runtimeConfig(),
      `archive-cleanup-worker-${suffix}`,
      unsafeInspector,
      failingStore,
    );
    await worker.runOnce();

    const retry = await jobs.get(String(job.jobId), context);
    expect(retry.status).toBe('retry_wait');
    expect((retry.error as { retryable?: boolean }).retryable).toBe(true);
    const blobId = createHash('sha1')
      .update(`archive:${String(job.jobId)}`)
      .digest('hex')
      .slice(0, 24);
    const pending = await objectRefs.findObjectRef(blobId, context);
    expect(pending?.state).toBe('deleting');

    await connection.models.KnowledgeJob.updateOne(
      {
        workspaceId: context.workspaceId,
        _id: new mongoose.Types.ObjectId(String(job.jobId)),
      },
      {
        $set: {
          status: 'queued',
          availableAt: new Date(0),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      },
    );
    const retryWorker = new KnowledgeArchiveWorker(
      connection,
      runtimeConfig(),
      `archive-cleanup-retry-worker-${suffix}`,
      unsafeInspector,
      objectStore,
    );
    await retryWorker.runOnce();
    const converged = await objectRefs.findObjectRef(blobId, context);
    expect(converged?.state).toBe('deleted');
  });

  it('TEST-FILE-004-A16 rejects unsafe archive output before active ObjectRef creation', async () => {
    const job = await jobs.createExportJob(
      {
        spaceId: knowledgeSpaceId,
        sourceIds: [sourceId],
        idempotencyKey: `archive-unsafe-${suffix}`,
      },
      context,
    );
    const config = {
      s3: {
        endpoint: process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
        bucket: objectStore.bucket,
        region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
        accessKeyRef: 'env:KB_TEST_S3_ACCESS_KEY',
        secretKeyRef: 'env:KB_TEST_S3_SECRET_KEY',
        credentialRefs: ['env:KB_TEST_S3_ACCESS_KEY', 'env:KB_TEST_S3_SECRET_KEY'],
      },
    } as unknown as KnowledgeRuntimeConfig;
    const unsafeInspector: ArchiveSafetyPort = {
      validateEntryPath() {
        return { safe: true };
      },
      async inspect() {
        return {
          archive: true,
          safe: false,
          status: 'unsupported',
          reason: 'zip_slip',
        };
      },
    };
    const worker = new KnowledgeArchiveWorker(
      connection,
      config,
      `archive-unsafe-worker-${suffix}`,
      unsafeInspector,
      objectStore,
    );
    await worker.runOnce();

    const failed = await jobs.get(String(job.jobId), context);
    expect(failed.status).toBe('failed');
    expect(failed.result).toBeNull();
    expect((failed.error as { code?: string }).code).toBe('KNOWLEDGE_UNSUPPORTED_CONTENT');

    const blobId = createHash('sha1')
      .update(`archive:${String(job.jobId)}`)
      .digest('hex')
      .slice(0, 24);
    const key = knowledgeObjectKey({
      workspaceId: context.workspaceId,
      knowledgeSpaceId,
      sourceId: 'unbound',
      purpose: 'export',
      blobId,
      safeName: 'sources.zip',
    });
    const pendingObject = await objectStore
      .headObject(objectStore.bucket, key, {
        workspaceId: context.workspaceId,
        knowledgeSpaceId,
        requestId: context.requestId,
        traceId: context.traceId,
      })
      .catch((error: unknown) => error);
    expect(
      (pendingObject as { problem?: { error?: { code?: string } } }).problem?.error?.code,
    ).toBe('KNOWLEDGE_NOT_FOUND');
  });
});

describe('TEST-FILE-004-BLOCK source archive admission', () => {
  it('TEST-FILE-004-A06 queues exactly 2000 Sources without creating a second Job', async () => {
    const sourceIds = Array.from({ length: 2000 }, (_, index) => `source-${index}`);
    const createExportJob = vi.fn(async (input: { sourceIds: string[] }) => ({
      kind: 'export',
      status: 'queued',
      sourceCount: input.sourceIds.length,
    }));
    const sources = {
      async getSource(id: string) {
        return {
          id,
          knowledgeSpaceId,
          searchEnabled: true,
          name: `${id}.txt`,
          sizeBytes: 1,
          mimeType: 'text/plain',
        };
      },
    } as unknown as CatalogPort;
    const jobs = { createExportJob } as unknown as JobPort;
    const permits = { async assertPermission() {} } as unknown as AccessPort;
    const application = new SourceFileApplication(
      sources,
      jobs,
      permits,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await application.archive(knowledgeSpaceId, sourceIds, context);
    expect(result).toMatchObject({ kind: 'export', status: 'queued', sourceCount: 2000 });
    expect(createExportJob).toHaveBeenCalledTimes(1);
    expect(createExportJob.mock.calls[0]?.[0].sourceIds).toHaveLength(2000);
  });

  it('TEST-FILE-004-A07 rejects 2001 Sources or more than 2048 MiB total', async () => {
    const tooManyIds = Array.from({ length: 2001 }, (_, index) => `source-${index}`);
    const makeApplication = (sizes: Map<string, number>) => {
      const sources = {
        async getSource(id: string) {
          return {
            id,
            knowledgeSpaceId,
            searchEnabled: true,
            name: `${id}.txt`,
            sizeBytes: sizes.get(id) ?? 1,
            mimeType: 'text/plain',
          };
        },
      } as unknown as CatalogPort;
      return new SourceFileApplication(
        sources,
        { createExportJob: vi.fn() } as unknown as JobPort,
        { async assertPermission() {} } as unknown as AccessPort,
        {} as never,
        {} as never,
        {} as never,
      );
    };

    await expect(
      makeApplication(new Map()).archive(knowledgeSpaceId, tooManyIds, context),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE' } },
    });
    const oversizedIds = ['large-a', 'large-b'];
    const oversized = new Map(oversizedIds.map((id) => [id, 1024 * 1024 * 1024 + 1]));
    await expect(
      makeApplication(oversized).archive(knowledgeSpaceId, oversizedIds, context),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE' } },
    });
  });
});
