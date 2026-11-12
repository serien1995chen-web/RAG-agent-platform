import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KnowledgeApiError, createKnowledgeError } from '@kb/contracts';
import { FileTicketService, MinioKnowledgeObjectStore } from '../../../../sdk/storage/src/index';
import { ObjectStoreArchiveSafetyAdapter } from '../../../../projects/app/src/runtime/archive-safety.adapter';
import { FileApplication } from '../../src/modules/knowledge/application/file.application';
import { ObjectLifecycleService } from '../../src/modules/knowledge/application/object-lifecycle';
import {
  FixtureQuotaGatePort,
  FixtureScopedAuthPort,
  S04IngestionApplication,
} from '../../src/modules/knowledge/application/operations/s04-ingestion';
import { KnowledgeIngestionContentAdapter } from '../../src/modules/knowledge/adapter/ingestion-content';
import { KnowledgeObjectRefRepository } from '../../src/modules/knowledge/repository/object-ref.repository';
import { KnowledgeImportRepository } from '../../src/modules/knowledge/repository/import.repository';
import { S5ArtifactRepository } from '../../src/modules/knowledge/repository/s5-artifact.repository';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import type {
  AccessPort,
  CatalogPort,
  ObjectRefView,
} from '../../src/modules/knowledge/application/ports';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = 'ws_b06a_' + suffix;
const otherWorkspaceId = 'ws_b06a_other_' + suffix;
const memberId = 'mem_b06a_' + suffix;

function tenant(workspace: string, member: string): TenantContext {
  return {
    workspaceId: workspace,
    memberId: member,
    requestId: 'req_b06a_' + suffix,
    traceId: suffix.padEnd(32, '0').slice(0, 32),
    scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
  };
}

const context = tenant(workspaceId, memberId);
const otherContext = tenant(otherWorkspaceId, 'mem_other_' + suffix);
const pdfPath = resolve(
  import.meta.dirname,
  '../../../../test/fixtures/s11/generated/s11-two-page.pdf',
);

let connection: mongoose.Connection;
let objectStore: MinioKnowledgeObjectStore;
let repository: KnowledgeObjectRefRepository;
let files: FileApplication;
let imports: KnowledgeImportRepository;
let ingestion: S04IngestionApplication;
let lifecycle: ObjectLifecycleService;
let spaceId = '';
let pdfBytes = Buffer.alloc(0);
const createdObjects = new Set<string>();
let denySpaceWrite = false;

function errorCode(error: unknown): string {
  expect(error).toBeInstanceOf(KnowledgeApiError);
  return (error as KnowledgeApiError).problem.error.code;
}

const catalog = {
  async getSpace(id: string) {
    return { id, knowledgeSpaceId: id };
  },
} as unknown as CatalogPort;

const access = {
  async assertPermission(resourceType: string, resourceId: string, action: string) {
    if (denySpaceWrite && resourceType === 'space' && action === 'write') {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: context.requestId,
        traceId: context.traceId,
      });
    }
    return { allowed: true };
  },
} as unknown as AccessPort;

function s5ArtifactStore() {
  return {
    provider: objectStore.provider,
    bucket: objectStore.bucket,
    async putObject(
      input: {
        key: string;
        body: Uint8Array;
        contentType: string;
        purpose: string;
        sha256: string;
        workspaceId: string;
        knowledgeSpaceId: string;
      },
      ctx: TenantContext,
    ) {
      const stored = await objectStore.putObject(
        {
          key: input.key,
          body: input.body,
          sizeBytes: input.body.byteLength,
          contentType: input.contentType,
          metadata: { purpose: input.purpose, sha256: input.sha256 },
          workspaceId: input.workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
        } as never,
        {
          workspaceId: ctx.workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
          requestId: ctx.requestId,
          traceId: ctx.traceId,
        },
      );
      return { key: stored.key, size: stored.size, etag: stored.etag, sha256: stored.sha256 };
    },
  };
}

function storageContext() {
  return {
    workspaceId,
    knowledgeSpaceId: spaceId,
    requestId: context.requestId,
    traceId: context.traceId,
  };
}

async function createRealSpace(workspace: string, member: string): Promise<string> {
  const document = await connection.models.KnowledgeSpace.create({
    workspaceId: workspace,
    knowledgeSpaceId: null,
    version: 1,
    deletedAt: null,
    createdByMemberId: member,
    updatedByMemberId: member,
    kind: 'space',
    parentSpaceId: null,
    name: 'B06A space ' + randomUUID().slice(0, 8),
    normalizedName: 'b06a-space-' + randomUUID(),
    description: '',
    iconKey: 'book-open',
    ownershipMemberId: member,
    accessMode: 'workspace',
    sourceAclMode: 'enforced',
    sourcePermissionEnabled: true,
    referenceRevision: 0,
    permissionRevision: 0,
    modelBindings: {},
    defaultChunking: {},
    status: 'active',
  });
  return String(document._id);
}

function ingestionApplication(): S04IngestionApplication {
  return new S04IngestionApplication({
    imports,
    connectors: {} as never,
    objectRefs: repository,
    content: new KnowledgeIngestionContentAdapter(objectStore as never),
    urlImport: {} as never,
    customApi: {} as never,
    providers: {} as never,
    access,
    scopedAuth: new FixtureScopedAuthPort(),
    quotaGate: new FixtureQuotaGatePort(),
    templateParser: {} as never,
  });
}

async function uploadObject(input: {
  name: string;
  mimeType: string;
  body: Buffer;
  owner?: TenantContext;
  targetSpace?: string;
  app?: FileApplication;
}): Promise<{ uploadId: string; ref: ObjectRefView; completed: ObjectRefView }> {
  const owner = input.owner ?? context;
  const targetSpace = input.targetSpace ?? spaceId;
  const app = input.app ?? files;
  const session = await app.init(
    {
      knowledgeSpaceId: targetSpace,
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes: input.body.byteLength,
    },
    owner,
  );
  const ref = await repository.findObjectRef(session.uploadId, owner);
  if (!ref) throw new Error('upload ref missing');
  createdObjects.add(ref.objectKey);
  if (ref.finalObjectKey) createdObjects.add(ref.finalObjectKey);
  const presigned = await app.presign(session.uploadId, { partNumbers: [1] }, owner);
  const response = await fetch(presigned.uploads[0]!.url, {
    method: 'PUT',
    headers: presigned.uploads[0]!.headers,
    body: input.body,
  });
  expect(response.status).toBe(200);
  const completed = await app.complete({ uploadId: session.uploadId, parts: [] }, owner);
  return { uploadId: session.uploadId, ref, completed };
}

function importBody(uploadIds: string[]) {
  return {
    uploadIds,
    parseProvider: 'liteparse' as const,
    parseConfig: {},
    chunking: { trainingType: 'chunk' as const, chunkSettingMode: 'auto' as const },
  };
}

function dispatchImport(input: {
  body: Record<string, unknown>;
  key: string;
  owner?: TenantContext;
  targetSpace?: string;
}) {
  return ingestion.dispatch({
    operationId: 'API-IMPORT-FILES',
    params: { spaceId: input.targetSpace ?? spaceId },
    query: {},
    headers: { 'idempotency-key': input.key },
    body: input.body,
    context: input.owner ?? context,
  });
}

async function counts(workspace = workspaceId) {
  const models = connection.models;
  const [sources, jobs, audits, outbox, usage] = await Promise.all([
    models.KnowledgeSource.countDocuments({ workspaceId: workspace, deletedAt: null }),
    models.KnowledgeJob.countDocuments({ workspaceId: workspace }),
    models.KnowledgeAuditEvent.countDocuments({ workspaceId: workspace }),
    models.KnowledgeOutboxEvent.countDocuments({ workspaceId: workspace }),
    models.KnowledgeUsageEvent.countDocuments({ workspaceId: workspace }),
  ]);
  return { sources, jobs, audits, outbox, usage };
}

beforeAll(async () => {
  const mongoUri = new URL(
    process.env.KB_TEST_MONGO_URI ??
      'mongodb://127.0.0.1:27017/kb_b06a_' + suffix + '?directConnection=true',
  );
  if (mongoUri.hostname === '127.0.0.1' || mongoUri.hostname === 'localhost') {
    mongoUri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(mongoUri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  registerKnowledgeModels(connection);

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
  await objectStore.ensureBucket(objectStore.bucket, {
    workspaceId,
    knowledgeSpaceId: 'bootstrap',
    requestId: context.requestId,
    traceId: context.traceId,
  });
  repository = new KnowledgeObjectRefRepository(connection);
  imports = new KnowledgeImportRepository(connection);
  files = new FileApplication(
    repository,
    objectStore,
    catalog,
    access,
    new FileTicketService(
      'b06a-integration-ticket-secret-at-least-32-bytes',
      'http://127.0.0.1:3010',
    ),
    new ObjectStoreArchiveSafetyAdapter(objectStore),
  );
  ingestion = ingestionApplication();
  lifecycle = new ObjectLifecycleService(repository, objectStore, 500);
  spaceId = await createRealSpace(workspaceId, memberId);
  pdfBytes = await readFile(pdfPath);
}, 90_000);

afterAll(async () => {
  if (connection) {
    const refs = await connection.models.KnowledgeObjectRef.find({
      workspaceId: { $in: [workspaceId, otherWorkspaceId] },
    }).lean();
    for (const ref of refs) {
      for (const key of [ref.objectKey, ref.upload?.pendingObjectKey, ref.upload?.finalObjectKey]) {
        if (typeof key === 'string' && key.length > 0) createdObjects.add(key);
      }
    }
  }
  for (const key of createdObjects) {
    await objectStore.deleteObject(key, storageContext()).catch(() => undefined);
  }
  if (connection) {
    for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
      const model = connection.models[entry.modelName];
      if (model) {
        await model.deleteMany({ workspaceId: { $in: [workspaceId, otherWorkspaceId] } });
      }
    }
    await connection.close();
  }
});

describe('TEST-ING-001-BLOCK upload to Source', () => {
  it('L1-B06-ING-001-P01 上传 PDF 后创建 Source 与 Job 并写入审计和 Outbox', async () => {
    const { uploadId, completed } = await uploadObject({
      name: 'b06a-sample.pdf',
      mimeType: 'application/pdf',
      body: pdfBytes,
    });
    expect(completed.state).toBe('active');
    expect(completed.sizeBytes).toBe(pdfBytes.byteLength);

    const result = await dispatchImport({
      body: importBody([uploadId]),
      key: 'b06a-p01-' + suffix,
    });
    expect(result.status).toBe(202);
    const jobId = String((result.data as { jobId: string }).jobId);
    expect(JSON.stringify(result.data)).not.toContain('objectKey');

    const source = await connection.models.KnowledgeSource.findOne({
      workspaceId,
      blobRefId: new mongoose.Types.ObjectId(uploadId),
    }).lean();
    expect(source).not.toBeNull();
    expect(source).toMatchObject({
      kind: 'file',
      sourceVersion: 1,
      name: 'b06a-sample.pdf',
      mimeType: 'application/pdf',
      sizeBytes: pdfBytes.byteLength,
      processingStatus: 'queued',
      searchEnabled: true,
    });
    expect(source!.contentHash).toBe(createHash('sha256').update(pdfBytes).digest('hex'));
    expect(String(source!.blobRefId)).toBe(uploadId);

    const object = await connection.models.KnowledgeObjectRef.findById(uploadId).lean();
    expect(object).toMatchObject({ state: 'active', purpose: 'source' });
    expect(object!.upload!.status).toBe('completed');
    expect(String(object!.sourceId)).toBe(String(source!._id));
    expect(object!.objectKey).toBe(object!.upload!.finalObjectKey);

    const job = await connection.models.KnowledgeJob.findById(jobId).lean();
    expect(job).toMatchObject({ kind: 'import', status: 'queued', resourceType: 'space' });
    expect((job!.inputSnapshot as { sourceIds: string[] }).sourceIds.map(String)).toEqual([
      String(source!._id),
    ]);

    const audit = await connection.models.KnowledgeAuditEvent.findOne({
      workspaceId,
      action: 'import.files.submit',
    }).lean();
    expect(audit).toMatchObject({ resourceType: 'job', resourceId: jobId, outcome: 'succeeded' });
    const outbox = await connection.models.KnowledgeOutboxEvent.findOne({
      workspaceId,
      eventType: 'import.submit',
    }).lean();
    expect(outbox).toMatchObject({ aggregateType: 'job', aggregateId: jobId });
    expect((outbox!.payload as { queue: string }).queue).toBe('knowledge-import');

    expect(await connection.models.KnowledgeUsageEvent.countDocuments({ workspaceId })).toBe(0);

    const artifacts = new S5ArtifactRepository(connection, s5ArtifactStore());
    const rawText = 'S11 OCR provider fixture page 1\nS11 OCR provider fixture page 2';
    const materialized = await artifacts.materialize(
      {
        sourceId: String(source!._id),
        sourceVersion: 1,
        knowledgeSpaceId: spaceId,
        parse: {
          format: 'pdf',
          rawText,
          pages: [
            { pageNumber: 1, text: 'S11 OCR provider fixture page 1', assets: [] },
            { pageNumber: 2, text: 'S11 OCR provider fixture page 2', assets: [] },
          ],
          assets: [],
          diagnostics: [],
          scanRequired: false,
          imageRefs: [],
          contentHash: createHash('sha256').update(rawText, 'utf8').digest('hex'),
          parserVersion: 'b06a-parser-1',
          configHash: 'b06a-config-1',
        },
      },
      context,
    );
    createdObjects.add(materialized.rawTextObjectRef.objectKey);
    const rawRef = await connection.models.KnowledgeObjectRef.findById(
      materialized.rawTextObjectRef.blobId,
    ).lean();
    expect(rawRef).toMatchObject({ state: 'active', purpose: 'source' });
    expect(rawRef!.sha256).toBe(createHash('sha256').update(rawText, 'utf8').digest('hex'));
    const refreshed = await connection.models.KnowledgeSource.findById(source!._id).lean();
    expect(refreshed!.contentHash).toBe(rawRef!.sha256);
  });

  it('L1-B06-ING-001-N01 未完成、取消、过期、空文件和超批量均不能创建 Source', async () => {
    const baseline = await counts();

    const pending = await files.init(
      {
        knowledgeSpaceId: spaceId,
        name: 'pending.pdf',
        mimeType: 'application/pdf',
        sizeBytes: pdfBytes.byteLength,
      },
      context,
    );
    const pendingRef = await repository.findObjectRef(pending.uploadId, context);
    if (pendingRef) {
      createdObjects.add(pendingRef.objectKey);
      if (pendingRef.finalObjectKey) createdObjects.add(pendingRef.finalObjectKey);
    }
    const pendingError = await dispatchImport({
      body: importBody([pending.uploadId]),
      key: 'b06a-n01-pending-' + suffix,
    }).catch((error: unknown) => error);
    expect(errorCode(pendingError)).toBe('KNOWLEDGE_NOT_FOUND');

    const cancelled = await files.init(
      {
        knowledgeSpaceId: spaceId,
        name: 'cancelled.pdf',
        mimeType: 'application/pdf',
        sizeBytes: pdfBytes.byteLength,
      },
      context,
    );
    const cancelledRef = await repository.findObjectRef(cancelled.uploadId, context);
    if (cancelledRef) createdObjects.add(cancelledRef.objectKey);
    await files.abort(cancelled.uploadId, cancelled.version, context);
    const cancelledError = await dispatchImport({
      body: importBody([cancelled.uploadId]),
      key: 'b06a-n01-aborted-' + suffix,
    }).catch((error: unknown) => error);
    expect(errorCode(cancelledError)).toBe('KNOWLEDGE_NOT_FOUND');

    const expired = await files.init(
      {
        knowledgeSpaceId: spaceId,
        name: 'expired.pdf',
        mimeType: 'application/pdf',
        sizeBytes: pdfBytes.byteLength,
      },
      context,
    );
    const expiredRef = await repository.findObjectRef(expired.uploadId, context);
    if (expiredRef) createdObjects.add(expiredRef.objectKey);
    await connection.models.KnowledgeObjectRef.updateOne(
      { _id: new mongoose.Types.ObjectId(expired.uploadId) },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );
    await files.get(expired.uploadId, context);
    const expiredError = await dispatchImport({
      body: importBody([expired.uploadId]),
      key: 'b06a-n01-expired-' + suffix,
    }).catch((error: unknown) => error);
    expect(errorCode(expiredError)).toBe('KNOWLEDGE_NOT_FOUND');

    const emptyError = await files
      .init(
        { knowledgeSpaceId: spaceId, name: 'empty.pdf', mimeType: 'application/pdf', sizeBytes: 0 },
        context,
      )
      .catch((error: unknown) => error);
    expect(errorCode(emptyError)).toBe('KNOWLEDGE_PAYLOAD_TOO_LARGE');

    const tooMany = await dispatchImport({
      body: importBody(Array.from({ length: 1_001 }, (_, index) => 'upload-' + index)),
      key: 'b06a-n01-bulk-' + suffix,
    }).catch((error: unknown) => error);
    expect(errorCode(tooMany)).toBe('KNOWLEDGE_VALIDATION_FAILED');

    const missing = await dispatchImport({
      body: {
        parseProvider: 'liteparse',
        chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
      },
      key: 'b06a-n01-missing-' + suffix,
    }).catch((error: unknown) => error);
    expect(errorCode(missing)).toBe('KNOWLEDGE_VALIDATION_FAILED');

    expect(await counts()).toEqual(baseline);
  });

  it('L1-B06-ING-001-A01 无写权限、跨租户和缺 TenantContext 全部 fail closed', async () => {
    const baseline = await counts();
    denySpaceWrite = true;
    try {
      const denied = await files
        .init(
          {
            knowledgeSpaceId: spaceId,
            name: 'denied.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 10,
          },
          context,
        )
        .catch((error: unknown) => error);
      expect(errorCode(denied)).toBe('KNOWLEDGE_FORBIDDEN');
      const deniedImport = await dispatchImport({
        body: importBody(['000000000000000000000001']),
        key: 'b06a-a01-denied-' + suffix,
      }).catch((error: unknown) => error);
      expect(errorCode(deniedImport)).toBe('KNOWLEDGE_FORBIDDEN');
    } finally {
      denySpaceWrite = false;
    }

    const { uploadId, ref } = await uploadObject({
      name: 'cross.pdf',
      mimeType: 'application/pdf',
      body: pdfBytes,
    });
    expect(await repository.findObjectRef(uploadId, otherContext)).toBeNull();
    const crossSession = await files.init(
      {
        knowledgeSpaceId: spaceId,
        name: 'cross-pending.pdf',
        mimeType: 'application/pdf',
        sizeBytes: pdfBytes.byteLength,
      },
      context,
    );
    const crossRef = await repository.findObjectRef(crossSession.uploadId, context);
    if (!crossRef) throw new Error('cross ref missing');
    createdObjects.add(crossRef.objectKey);
    const presigned = await files.presign(crossSession.uploadId, { partNumbers: [1] }, context);
    expect(presigned.uploads[0]!.url).toContain(crossRef.pendingObjectKey ?? crossRef.objectKey);
    expect(presigned.uploads[0]!.url).not.toContain(otherWorkspaceId);
    expect(presigned.uploads[0]!.url).not.toContain('X-Amz-Security-Token');
    await files.abort(crossSession.uploadId, crossSession.version, context);

    const otherSpaceId = await createRealSpace(otherWorkspaceId, otherContext.memberId);
    const otherImport = await dispatchImport({
      body: importBody([uploadId]),
      key: 'b06a-a01-other-' + suffix,
      owner: otherContext,
      targetSpace: otherSpaceId,
    }).catch((error: unknown) => error);
    expect(errorCode(otherImport)).toBe('KNOWLEDGE_NOT_FOUND');

    const missingContext = { ...context, workspaceId: '' } as TenantContext;
    const missing = await repository
      .findUploadSession(uploadId, missingContext)
      .catch((error: unknown) => error);
    expect(errorCode(missing)).toBe('KNOWLEDGE_VALIDATION_FAILED');
    expect(JSON.stringify((otherImport as KnowledgeApiError).problem)).not.toContain(ref.objectKey);
    expect(await counts(otherWorkspaceId)).toEqual({
      sources: 0,
      jobs: 0,
      audits: 0,
      outbox: 0,
      usage: 0,
    });
    expect(await counts()).toEqual(baseline);
  });

  it('L1-B06-ING-001-S01 Source、rawText、upload 记录一致且清理不删除活动对象', async () => {
    const { uploadId, completed } = await uploadObject({
      name: 'consistency.pdf',
      mimeType: 'application/pdf',
      body: pdfBytes,
    });
    await dispatchImport({ body: importBody([uploadId]), key: 'b06a-s01-' + suffix });
    const source = await connection.models.KnowledgeSource.findOne({
      workspaceId,
      blobRefId: new mongoose.Types.ObjectId(uploadId),
    }).lean();
    expect(source).toMatchObject({ sourceVersion: 1, deletedAt: null });
    const ref = await repository.findObjectRef(uploadId, context);
    expect(ref).toMatchObject({ state: 'active', purpose: 'source', uploadStatus: 'completed' });
    expect(String(ref!.sourceId)).toBe(String(source!._id));

    const job = await connection.models.KnowledgeJob.findOne({
      workspaceId,
      idempotencyKey: 'b06a-s01-' + suffix,
    }).lean();
    const snapshotSourceIds = (job!.inputSnapshot as { sourceIds: unknown[] }).sourceIds;
    expect(snapshotSourceIds.map(String)).toEqual([String(source!._id)]);

    const activeHead = await objectStore.headObject(
      objectStore.bucket,
      ref!.objectKey,
      storageContext(),
    );
    expect(activeHead.etag).toBe(completed.etag);

    await lifecycle.cleanup(context, new Date(Date.now() + 4 * 60 * 60 * 1000));
    const after = await repository.findObjectRef(uploadId, context);
    expect(after?.state).toBe('active');
    const stillThere = await objectStore.headObject(
      objectStore.bucket,
      ref!.objectKey,
      storageContext(),
    );
    expect(stillThere.size).toBe(pdfBytes.byteLength);

    const aborted = await files.init(
      {
        knowledgeSpaceId: spaceId,
        name: 'cancel-cleanup.pdf',
        mimeType: 'application/pdf',
        sizeBytes: pdfBytes.byteLength,
      },
      context,
    );
    const abortedRef = await repository.findObjectRef(aborted.uploadId, context);
    if (!abortedRef) throw new Error('aborted ref missing');
    createdObjects.add(abortedRef.objectKey);
    const presigned = await files.presign(aborted.uploadId, { partNumbers: [1] }, context);
    await fetch(presigned.uploads[0]!.url, {
      method: 'PUT',
      headers: presigned.uploads[0]!.headers,
      body: pdfBytes,
    });
    await files.abort(aborted.uploadId, aborted.version, context);
    await connection.models.KnowledgeObjectRef.updateOne(
      { _id: new mongoose.Types.ObjectId(aborted.uploadId) },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );
    await lifecycle.cleanup(context, new Date(Date.now() + 1_000));
    const abortedAfter = await repository.findObjectRef(aborted.uploadId, context);
    expect(['deleted', 'deleting']).toContain(abortedAfter?.state);
    const abortedHead = await objectStore
      .headObject(objectStore.bucket, abortedRef.objectKey, storageContext())
      .catch((error: unknown) => error);
    expect(errorCode(abortedHead)).toBe('KNOWLEDGE_NOT_FOUND');
  });

  it('L1-B06-ING-001-C01 complete/abort 单终态、重复 complete 与导入幂等', async () => {
    const race = await uploadObject({
      name: 'race.pdf',
      mimeType: 'application/pdf',
      body: pdfBytes,
    });
    const session = await files.get(race.uploadId, context);
    const results = await Promise.allSettled([
      files.complete({ uploadId: race.uploadId, parts: [] }, context),
      files.abort(race.uploadId, session.version, context),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    const { uploadId } = await uploadObject({
      name: 'repeat.pdf',
      mimeType: 'application/pdf',
      body: pdfBytes,
    });
    const first = await files.complete({ uploadId, parts: [] }, context);
    const second = await files.complete({ uploadId, parts: [] }, context);
    expect(second.blobId).toBe(first.blobId);
    expect(second.etag).toBe(first.etag);

    const key = 'b06a-c01-idem-' + suffix;
    const firstImport = await dispatchImport({ body: importBody([uploadId]), key });
    const replay = await dispatchImport({ body: importBody([uploadId]), key });
    expect((replay.data as { jobId: string }).jobId).toBe(
      (firstImport.data as { jobId: string }).jobId,
    );
    expect(
      await connection.models.KnowledgeSource.countDocuments({
        workspaceId,
        blobRefId: new mongoose.Types.ObjectId(uploadId),
      }),
    ).toBe(1);
    expect(
      await connection.models.KnowledgeJob.countDocuments({ workspaceId, idempotencyKey: key }),
    ).toBe(1);

    const secondUpload = await uploadObject({
      name: 'independent.pdf',
      mimeType: 'application/pdf',
      body: pdfBytes,
    });
    const otherImport = await dispatchImport({
      body: importBody([secondUpload.uploadId]),
      key: 'b06a-c01-independent-' + suffix,
    });
    expect((otherImport.data as { jobId: string }).jobId).not.toBe(
      (firstImport.data as { jobId: string }).jobId,
    );
    expect(
      await connection.models.KnowledgeSource.countDocuments({
        workspaceId,
        blobRefId: new mongoose.Types.ObjectId(secondUpload.uploadId),
      }),
    ).toBe(1);
  });

  it('L1-B06-ING-001-F01 中断后复用同一会话，S3 超时补偿后重试终态一致', async () => {
    const resumed = await uploadObject({
      name: 'resume.pdf',
      mimeType: 'application/pdf',
      body: pdfBytes,
    });
    expect(
      await connection.models.KnowledgeObjectRef.countDocuments({
        workspaceId,
        _id: new mongoose.Types.ObjectId(resumed.uploadId),
      }),
    ).toBe(1);
    const reloaded = await files.get(resumed.uploadId, context);
    expect(reloaded.status).toBe('completed');

    const session = await files.init(
      {
        knowledgeSpaceId: spaceId,
        name: 'timeout.pdf',
        mimeType: 'application/pdf',
        sizeBytes: pdfBytes.byteLength,
      },
      context,
    );
    const ref = await repository.findObjectRef(session.uploadId, context);
    if (!ref) throw new Error('timeout ref missing');
    createdObjects.add(ref.objectKey);
    if (ref.finalObjectKey) createdObjects.add(ref.finalObjectKey);
    const presigned = await files.presign(session.uploadId, { partNumbers: [1] }, context);
    await fetch(presigned.uploads[0]!.url, {
      method: 'PUT',
      headers: presigned.uploads[0]!.headers,
      body: pdfBytes,
    });

    let failed = false;
    const flakyStore = new Proxy(objectStore, {
      get(target, property) {
        if (property === 'copyObjectImmutable') {
          return async (input: never, ctx: never) => {
            if (!failed) {
              failed = true;
              throw createKnowledgeError({
                code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
                requestId: context.requestId,
                traceId: context.traceId,
                details: { operation: 'copyObjectImmutable' },
              });
            }
            return target.copyObjectImmutable(input, ctx);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const flakyFiles = new FileApplication(
      repository,
      flakyStore,
      catalog,
      access,
      undefined,
      new ObjectStoreArchiveSafetyAdapter(flakyStore),
    );
    const timeout = await flakyFiles
      .complete({ uploadId: session.uploadId, parts: [] }, context)
      .catch((error: unknown) => error);
    expect(errorCode(timeout)).toBe('KNOWLEDGE_DEPENDENCY_TIMEOUT');
    const midState = await repository.findObjectRef(session.uploadId, context);
    expect(midState?.state).not.toBe('active');

    const recovered = await files.complete({ uploadId: session.uploadId, parts: [] }, context);
    expect(recovered.state).toBe('active');
    expect(recovered.sizeBytes).toBe(pdfBytes.byteLength);

    const restartedRepository = new KnowledgeObjectRefRepository(connection);
    const afterRestart = await restartedRepository.findUploadSession(session.uploadId, context);
    expect(afterRestart?.status).toBe('completed');

    const stale = await files.init(
      {
        knowledgeSpaceId: spaceId,
        name: 'stale.pdf',
        mimeType: 'application/pdf',
        sizeBytes: pdfBytes.byteLength,
      },
      context,
    );
    const staleRef = await repository.findObjectRef(stale.uploadId, context);
    if (staleRef) createdObjects.add(staleRef.objectKey);
    await connection.models.KnowledgeObjectRef.updateOne(
      { _id: new mongoose.Types.ObjectId(stale.uploadId) },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );
    const expired = await files.get(stale.uploadId, context);
    expect(expired.status).toBe('expired');
  });

  it('L1-B06-FILE-001-P01 单 PUT 与 Multipart 的 ETag、大小和 content-type 一致', async () => {
    const single = await uploadObject({
      name: 'single.txt',
      mimeType: 'text/plain',
      body: Buffer.from('b06a single put body'),
    });
    const singleHead = await objectStore.headObject(
      objectStore.bucket,
      single.completed.objectKey,
      storageContext(),
    );
    expect(singleHead.size).toBe(single.completed.sizeBytes);
    expect(singleHead.etag).toBe(single.completed.etag);
    expect(singleHead.contentType).toContain('text/plain');

    const totalSize = 8 * 1024 * 1024 + 7;
    const body = Buffer.alloc(totalSize, 0x61);
    const session = await files.init(
      {
        knowledgeSpaceId: spaceId,
        name: 'multipart.txt',
        mimeType: 'text/plain',
        sizeBytes: totalSize,
      },
      context,
    );
    expect(session.mode).toBe('multipart');
    const ref = await repository.findObjectRef(session.uploadId, context);
    if (!ref) throw new Error('multipart ref missing');
    createdObjects.add(ref.objectKey);
    if (ref.finalObjectKey) createdObjects.add(ref.finalObjectKey);
    const partOne = await files.uploadPart(
      session.uploadId,
      1,
      body.subarray(0, 8 * 1024 * 1024),
      context,
    );
    const partTwo = await files.uploadPart(
      session.uploadId,
      2,
      body.subarray(8 * 1024 * 1024),
      context,
    );
    const presignedAgain = await files.presign(session.uploadId, { partNumbers: [1, 2] }, context);
    expect(presignedAgain.uploads.map((item) => item.partNumber)).toEqual([1, 2]);
    const completed = await files.complete(
      { uploadId: session.uploadId, parts: [partOne, partTwo] },
      context,
    );
    expect(completed.sizeBytes).toBe(totalSize);
    const head = await objectStore.headObject(
      objectStore.bucket,
      completed.objectKey,
      storageContext(),
    );
    expect(head.size).toBe(totalSize);
    expect(head.etag).toBe(completed.etag);
    expect(head.contentType).toContain('text/plain');
  });

  it('L1-B06-FILE-001-N01 缺片、重复 partNumber、零字节分片和重复 complete 均明确失败', async () => {
    const totalSize = 8 * 1024 * 1024 + 7;
    const body = Buffer.alloc(totalSize, 0x62);
    const session = await files.init(
      {
        knowledgeSpaceId: spaceId,
        name: 'invalid-parts.txt',
        mimeType: 'text/plain',
        sizeBytes: totalSize,
      },
      context,
    );
    const ref = await repository.findObjectRef(session.uploadId, context);
    if (!ref) throw new Error('invalid parts ref missing');
    createdObjects.add(ref.objectKey);

    const zero = await files
      .uploadPart(session.uploadId, 1, Buffer.alloc(0), context)
      .catch((error: unknown) => error);
    expect(errorCode(zero)).toBe('KNOWLEDGE_PAYLOAD_TOO_LARGE');
    const oversized = await files
      .uploadPart(session.uploadId, 1, Buffer.alloc(8 * 1024 * 1024 + 1), context)
      .catch((error: unknown) => error);
    expect(errorCode(oversized)).toBe('KNOWLEDGE_PAYLOAD_TOO_LARGE');

    const partOne = await files.uploadPart(
      session.uploadId,
      1,
      body.subarray(0, 8 * 1024 * 1024),
      context,
    );
    const duplicate = await files
      .complete(
        { uploadId: session.uploadId, parts: [partOne, { partNumber: 1, etag: partOne.etag }] },
        context,
      )
      .catch((error: unknown) => error);
    expect(errorCode(duplicate)).toBe('KNOWLEDGE_VALIDATION_FAILED');

    const missingPart = await files
      .complete({ uploadId: session.uploadId, parts: [partOne] }, context)
      .catch((error: unknown) => error);
    expect(errorCode(missingPart)).toBe('KNOWLEDGE_VALIDATION_FAILED');

    const second = await files.uploadPart(
      session.uploadId,
      2,
      body.subarray(8 * 1024 * 1024),
      context,
    );
    const completed = await files.complete(
      { uploadId: session.uploadId, parts: [partOne, second] },
      context,
    );
    const repeat = await files.complete(
      { uploadId: session.uploadId, parts: [partOne, second] },
      context,
    );
    expect(repeat.blobId).toBe(completed.blobId);
    expect(repeat.etag).toBe(completed.etag);
  });
});
