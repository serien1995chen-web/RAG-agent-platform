import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeImportRepository } from '../../src/modules/knowledge/repository/import.repository';
import { KnowledgeObjectRefRepository } from '../../src/modules/knowledge/repository/object-ref.repository';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import {
  FixtureQuotaGatePort,
  FixtureScopedAuthPort,
  S04IngestionApplication,
} from '../../src/modules/knowledge/application/operations/s04-ingestion';
import { KnowledgeIngestionContentAdapter } from '../../src/modules/knowledge/adapter/ingestion-content';
import { S06ProcessingApplication } from '../../src/modules/knowledge/application/s06-processing.application';
import { KnowledgeJobExecutionRepository } from '../../src/modules/knowledge/repository/job-execution.repository';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s8_source_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s8_${suffix}`,
  requestId: `req_s8_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
};

let connection: mongoose.Connection;
let spaceId: string;
let uploadId: string;

async function createSpace() {
  const document = await connection.models.KnowledgeSpace.create({
    workspaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    kind: 'space',
    parentSpaceId: null,
    name: `S8 images ${suffix}`,
    normalizedName: `s8-images-${suffix}`,
    description: '',
    iconKey: 'book-open',
    ownershipMemberId: context.memberId,
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

async function createUpload(index = 0) {
  const model = connection.models.KnowledgeObjectRef;
  const id = new mongoose.Types.ObjectId();
  const now = new Date();
  await model.create({
    _id: id,
    workspaceId,
    knowledgeSpaceId: new mongoose.Types.ObjectId(spaceId),
    version: 2,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    provider: 'minio',
    bucket: 'kb-test',
    objectKey: `ws/${workspaceId}/space/${spaceId}/upload/${id}/refund-${index}.png`,
    purpose: 'source',
    sourceId: null,
    mimeType: 'image/png',
    sizeBytes: 128,
    etag: 'etag',
    sha256: 'sha256',
    state: 'active',
    expiresAt: null,
    upload: {
      mode: 'single',
      status: 'completed',
      providerUploadId: null,
      pendingObjectKey: null,
      finalObjectKey: `ws/${workspaceId}/space/${spaceId}/upload/${id}/refund-${index}.png`,
      finalizedAt: now,
      pendingUrlExpiresAt: null,
      partSizeBytes: 128,
      partCount: 1,
      parts: [],
      originalName: `refund-${index}.png`,
      completedAt: now,
      abortedAt: null,
    },
  });
  return String(id);
}

beforeAll(async () => {
  const uri = new URL(
    process.env.KB_TEST_MONGO_URI ??
      `mongodb://127.0.0.1:27017/kb_s8_source_${suffix}?directConnection=true`,
  );
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  spaceId = await createSpace();
  uploadId = await createUpload();
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('TEST-MULTI-001-BLOCK / TEST-TRAIN-001-BLOCK image source', () => {
  it('creates image Source, purpose=image ObjectRef and caption child without parse child', async () => {
    const objectRefs = new KnowledgeObjectRefRepository(connection);
    const imports = new KnowledgeImportRepository(connection);
    const content = new KnowledgeIngestionContentAdapter({
      provider: 'minio',
      bucket: 'kb-test',
      async putObject() {
        throw new Error('not used');
      },
      async getObject() {
        throw new Error('not used');
      },
      async deleteObject() {
        return { deleted: true };
      },
    });
    const ingestion = new S04IngestionApplication({
      imports,
      connectors: {} as never,
      objectRefs,
      content,
      urlImport: {} as never,
      customApi: {} as never,
      providers: {} as never,
      access: { async assertPermission() {} } as never,
      scopedAuth: new FixtureScopedAuthPort(),
      quotaGate: new FixtureQuotaGatePort(),
      templateParser: {} as never,
    });
    const result = await ingestion.dispatch({
      operationId: 'API-IMPORT-FILES',
      params: { spaceId },
      query: {},
      headers: { 'idempotency-key': `s8-image-source-${suffix}-0001` },
      body: {
        uploadIds: [uploadId],
        parseProvider: 'liteparse',
        parseConfig: {},
        chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
      },
      context,
    });
    expect(result.status).toBe(202);
    expect(JSON.stringify(result.data)).not.toContain('objectKey');

    const source = await connection.models.KnowledgeSource.findOne({ workspaceId }).lean();
    expect(source).toMatchObject({ kind: 'image', sourceVersion: 1, processingStatus: 'queued' });
    const object = await connection.models.KnowledgeObjectRef.findOne({
      workspaceId,
      _id: uploadId,
    }).lean();
    expect(object).toMatchObject({
      purpose: 'image',
      sourceId: source!._id,
      state: 'active',
    });
    const outbox = await connection.models.KnowledgeOutboxEvent.findOne({
      workspaceId,
      eventType: 'import.submit',
    }).lean();
    expect(outbox).not.toBeNull();

    const jobs = new KnowledgeJobExecutionRepository(connection);
    const sourceStore = {
      async getSource(sourceId: string) {
        const document = await connection.models.KnowledgeSource.findOne({
          workspaceId,
          _id: sourceId,
          deletedAt: null,
        }).lean();
        if (!document) return null;
        return {
          id: String(document._id),
          workspaceId: document.workspaceId,
          knowledgeSpaceId: String(document.knowledgeSpaceId),
          kind: document.kind,
          sourceVersion: document.sourceVersion,
          blobRefId: document.blobRefId ? String(document.blobRefId) : null,
          name: document.name,
          mimeType: document.mimeType,
          parseProvider: document.parseProvider,
          searchEnabled: document.searchEnabled,
          processingStatus: document.processingStatus,
          version: document.version,
        };
      },
      async updateSourcesStatus(ids: readonly string[], status: string) {
        await connection.models.KnowledgeSource.updateMany(
          { workspaceId, _id: { $in: ids } },
          { $set: { processingStatus: status } },
        );
      },
    };
    const processing = new S06ProcessingApplication({
      jobs,
      store: sourceStore as never,
      artifacts: {} as never,
      processing: {} as never,
      vectors: {} as never,
      fulltext: {} as never,
      models: {} as never,
      bindings: {} as never,
      port: {} as never,
    });
    expect(await processing.handleImport(String(outbox!._id), `worker-${suffix}`, context)).toBe(
      'succeeded',
    );
    const caption = await connection.models.KnowledgeJob.findOne({
      workspaceId,
      kind: 'caption',
      resourceId: String(source!._id),
    }).lean();
    const parse = await connection.models.KnowledgeJob.findOne({
      workspaceId,
      kind: 'parse',
      resourceId: String(source!._id),
    }).lean();
    expect(caption).toMatchObject({
      status: 'queued',
      inputSnapshot: expect.objectContaining({
        imageBlobRefId: uploadId,
        sourceVersion: 1,
      }),
    });
    expect(parse).toBeNull();
  }, 60_000);

  it('rejects cross-space uploads and more than ten images before any Source writes', async () => {
    const objectRefs = new KnowledgeObjectRefRepository(connection);
    const content = new KnowledgeIngestionContentAdapter({} as never);
    const ingestion = new S04IngestionApplication({
      imports: new KnowledgeImportRepository(connection),
      connectors: {} as never,
      objectRefs,
      content,
      urlImport: {} as never,
      customApi: {} as never,
      providers: {} as never,
      access: { async assertPermission() {} } as never,
      scopedAuth: new FixtureScopedAuthPort(),
      quotaGate: new FixtureQuotaGatePort(),
      templateParser: {} as never,
    });
    const uploadIds = [uploadId];
    for (let index = 1; index < 11; index += 1) {
      uploadIds.push(await createUpload(index));
    }
    await expect(
      ingestion.dispatch({
        operationId: 'API-IMPORT-FILES',
        params: { spaceId },
        query: {},
        headers: { 'idempotency-key': `s8-image-overflow-${suffix}` },
        body: {
          uploadIds,
          parseProvider: 'liteparse',
          parseConfig: {},
          chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
        },
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE' } },
    });
    expect(await connection.models.KnowledgeSource.countDocuments({ workspaceId })).toBe(0);
  }, 60_000);
});
