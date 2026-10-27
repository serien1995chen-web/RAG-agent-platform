import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MinioKnowledgeObjectStore } from '../../../../sdk/storage/src/index';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import { KnowledgeConnectorSyncApplication } from '../../src/modules/knowledge/application/s06-connector-sync.application';
import { S06ProcessingApplication } from '../../src/modules/knowledge/application/s06-processing.application';
import { S5ProcessingApplication } from '../../src/modules/knowledge/application/s5-processing.application';
import { KnowledgeCredentialCipher } from '../../src/modules/knowledge/adapter/credential-cipher';
import { KnowledgeIngestionContentAdapter } from '../../src/modules/knowledge/adapter/ingestion-content';
import { FeishuConnectorClient } from '../../src/modules/knowledge/adapter/connectors/feishu';
import { KnowledgeConnectorRepository } from '../../src/modules/knowledge/repository/connector.repository';
import { KnowledgeImportRepository } from '../../src/modules/knowledge/repository/import.repository';
import { KnowledgeJobExecutionRepository } from '../../src/modules/knowledge/repository/job-execution.repository';
import { S6ProcessingRepository } from '../../src/modules/knowledge';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s6_connector_sync_${suffix}`;
const spaceId = new mongoose.Types.ObjectId();
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s6_connector_sync_${suffix}`,
  requestId: `req_s6_connector_sync_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
};

let connection: mongoose.Connection;
let objectStore: MinioKnowledgeObjectStore;
let connectors: KnowledgeConnectorRepository;
let jobs: KnowledgeJobExecutionRepository;
let processing: S06ProcessingApplication;
let docAChanged = false;

beforeAll(async () => {
  const mongoUri = new URL(requiredEnv('KB_TEST_MONGO_URI'));
  if (mongoUri.hostname === '127.0.0.1' || mongoUri.hostname === 'localhost') {
    mongoUri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(mongoUri.toString(), {
    serverSelectionTimeoutMS: 5_000,
  });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  const models = registerKnowledgeModels(connection);
  await models.KnowledgeSpace.create({
    _id: spaceId,
    workspaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    kind: 'space',
    parentSpaceId: null,
    name: `S6 connector sync ${suffix}`,
    description: '',
    iconKey: 'book-open',
    ownershipMemberId: context.memberId,
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
    referenceRevision: 0,
    permissionRevision: 0,
    modelBindings: {},
    defaultChunking: {},
    status: 'active',
  });
  const endpoint = new URL(requiredEnv('KB_TEST_S3_ENDPOINT'));
  objectStore = new MinioKnowledgeObjectStore({
    provider: 'minio',
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey: requiredEnv('KB_TEST_S3_ACCESS_KEY'),
    secretKey: requiredEnv('KB_TEST_S3_SECRET_KEY'),
    region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
    bucket: requiredEnv('KB_TEST_S3_BUCKET'),
  });
  await objectStore.ensureBucket({
    workspaceId,
    knowledgeSpaceId: String(spaceId),
    requestId: context.requestId,
    traceId: context.traceId,
  });
  const cipher = new KnowledgeCredentialCipher('c'.repeat(32));
  connectors = new KnowledgeConnectorRepository(connection, cipher);
  const imports = new KnowledgeImportRepository(connection);
  const content = new KnowledgeIngestionContentAdapter(objectStore);
  const feishu = new FeishuConnectorClient();
  const sync = new KnowledgeConnectorSyncApplication({
    connectors,
    gateway: {
      catalog(input) {
        return feishu.catalog({
          config: input.config,
          credentials: input.credentials,
          rootId: input.rootId,
          ...(input.cursor ? { cursor: input.cursor } : {}),
          context: input.context,
        });
      },
      async content(input) {
        const contents = await feishu.content({
          config: input.config,
          credentials: input.credentials,
          externalIds: input.externalIds,
          context: input.context,
        });
        return contents.map((content) =>
          docAChanged && content.externalId === 'doc_a'
            ? {
                ...content,
                bytes: Buffer.from('# Runbook\n\nChanged connector content.', 'utf8'),
              }
            : content,
        );
      },
    },
    content,
    imports,
  });
  jobs = new KnowledgeJobExecutionRepository(connection);
  processing = new S06ProcessingApplication({
    jobs,
    store: new S6ProcessingRepository(connection),
    artifacts: {
      async materialize() {
        throw new Error('parse artifact is not used by connector discovery');
      },
    },
    processing: new S5ProcessingApplication(),
    vectors: {
      async insert() {
        return { inserted: 0, vectorIds: [] };
      },
      async deleteBySegment() {
        return { deleted: 0 };
      },
      listProfiles() {
        return [];
      },
      async cleanupUnreferenced() {
        return { deleted: 0, byProfile: {} };
      },
    },
    fulltext: {
      async project() {
        throw new Error('full text is not used by connector discovery');
      },
    },
    models: {
      async listModels() {
        return [];
      },
    },
    bindings: {
      async list() {
        return [];
      },
    },
    sync,
    port: {
      async parse() {
        throw new Error('parse is not used by connector discovery');
      },
      async embed() {
        return [];
      },
      async dispatchOutbox() {
        return false;
      },
    },
  });
}, 60_000);

afterAll(async () => {
  if (connection) {
    const models = registerKnowledgeModels(connection);
    const refs = await models.KnowledgeObjectRef.find({ workspaceId }).lean();
    for (const ref of refs) {
      await objectStore
        .deleteObject(ref.objectKey, {
          workspaceId,
          knowledgeSpaceId: String(ref.knowledgeSpaceId),
          requestId: context.requestId,
          traceId: context.traceId,
        })
        .catch(() => undefined);
    }
    for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
      await connection.models[entry.modelName]?.deleteMany({ workspaceId });
    }
    await connection.close();
  }
});

describe('S6 connector sync discovery', () => {
  it('commits provider pages, preserves cursor CAS, fans out once and completes connector state', async () => {
    const connected = await connectors.connect(
      String(spaceId),
      {
        provider: 'feishu',
        name: 'S6 sync',
        credentials: { provider: 'feishu', appId: 'app-id', appSecret: 'secret' },
        config: { provider: 'feishu', folderToken: 'safe-token' },
        syncEnabled: true,
        syncIntervalMinutes: 60,
      },
      context,
    );
    const first = await connectors.markSyncing(
      connected.id,
      {
        full: false,
        requestHash: `sync-page-1-${suffix}`,
        idempotencyKey: `sync-page-1-${suffix}`,
      },
      context,
    );
    const models = registerKnowledgeModels(connection);
    const queuedSyncJob = await models.KnowledgeJob.findById(first.job.jobId).lean();
    expect(queuedSyncJob?.inputSnapshot).not.toHaveProperty('sourceIds');
    expect(queuedSyncJob?.inputSnapshot).toMatchObject({
      connectorId: connected.id,
      full: false,
      cursorVersion: 1,
    });
    expect(
      await processing.handleQueue(
        'knowledge-sync',
        first.job.jobId,
        `sync-worker-${suffix}`,
        context,
      ),
    ).toBe('succeeded');
    const firstRoot = await jobs.getRaw(first.job.jobId, context);
    expect(firstRoot.status).toBe('running');
    expect(firstRoot.progress.stage).toBe('waiting_children');
    const firstSources = await models.KnowledgeSource.find({
      workspaceId,
      connectorId: connected.id,
      deletedAt: null,
    }).lean();
    expect(firstSources).toHaveLength(1);
    expect(firstSources[0]).toMatchObject({
      externalId: 'doc_a',
      sourceVersion: 1,
      processingStatus: 'parsing',
    });
    const firstChildren = await models.KnowledgeJob.find({
      workspaceId,
      kind: 'parse',
      'inputSnapshot.rootJobId': first.job.jobId,
    }).lean();
    expect(firstChildren).toHaveLength(1);
    expect(await models.KnowledgeObjectRef.countDocuments({ workspaceId, state: 'active' })).toBe(
      1,
    );
    const firstCursor = await connectors.getSyncCursor(connected.id, 'safe-token', context);
    expect(firstCursor).toMatchObject({
      cursor: { page: 'page:2' },
      cursorVersion: 2,
      syncRunId: first.job.jobId,
    });
    expect((await connectors.get(connected.id, context)).cursorVersion).toBe(2);

    expect(
      await processing.handleQueue(
        'knowledge-sync',
        first.job.jobId,
        `sync-duplicate-${suffix}`,
        context,
      ),
    ).toBe('retry');
    expect(
      await models.KnowledgeSource.countDocuments({
        workspaceId,
        connectorId: connected.id,
        deletedAt: null,
      }),
    ).toBe(1);
    expect(await models.KnowledgeObjectRef.countDocuments({ workspaceId, state: 'active' })).toBe(
      1,
    );
    expect(
      await models.KnowledgeJob.countDocuments({
        workspaceId,
        kind: 'parse',
        'inputSnapshot.rootJobId': first.job.jobId,
      }),
    ).toBe(1);

    await models.KnowledgeJob.updateOne(
      { _id: firstChildren[0]!._id, workspaceId },
      {
        $set: {
          status: 'succeeded',
          progress: { stage: 'succeeded', completed: 1, total: 1, percent: 100 },
        },
      },
    );
    await processing.handleQueue(
      'knowledge-sync',
      first.job.jobId,
      `sync-complete-${suffix}`,
      context,
    );
    expect((await jobs.getRaw(first.job.jobId, context)).status).toBe('succeeded');
    expect((await connectors.get(connected.id, context)).status).toBe('active');

    const second = await connectors.markSyncing(
      connected.id,
      {
        full: false,
        requestHash: `sync-page-2-${suffix}`,
        idempotencyKey: `sync-page-2-${suffix}`,
      },
      context,
    );
    expect(
      await processing.handleQueue(
        'knowledge-sync',
        second.job.jobId,
        `sync-worker-page-2-${suffix}`,
        context,
      ),
    ).toBe('succeeded');
    const secondSources = await models.KnowledgeSource.find({
      workspaceId,
      connectorId: connected.id,
      deletedAt: null,
    }).lean();
    expect(secondSources.map((source) => source.externalId).sort()).toEqual(['doc_a', 'doc_b']);
    expect(await models.KnowledgeObjectRef.countDocuments({ workspaceId, state: 'active' })).toBe(
      2,
    );
    expect(await connectors.getSyncCursor(connected.id, 'safe-token', context)).toMatchObject({
      cursor: { page: null },
      cursorVersion: 3,
      syncRunId: second.job.jobId,
    });
    expect((await connectors.get(connected.id, context)).cursorVersion).toBe(3);

    const secondChildren = await models.KnowledgeJob.find({
      workspaceId,
      kind: 'parse',
      'inputSnapshot.rootJobId': second.job.jobId,
    }).lean();
    expect(secondChildren).toHaveLength(1);
    await models.KnowledgeJob.updateOne(
      { _id: secondChildren[0]!._id, workspaceId },
      {
        $set: {
          status: 'succeeded',
          progress: { stage: 'succeeded', completed: 1, total: 1, percent: 100 },
        },
      },
    );
    await processing.handleQueue(
      'knowledge-sync',
      second.job.jobId,
      `sync-complete-page-2-${suffix}`,
      context,
    );
    expect((await connectors.get(connected.id, context)).status).toBe('active');

    docAChanged = true;
    const changed = await connectors.markSyncing(
      connected.id,
      {
        full: true,
        requestHash: `sync-doc-a-changed-${suffix}`,
        idempotencyKey: `sync-doc-a-changed-${suffix}`,
      },
      context,
    );
    expect(
      await processing.handleQueue(
        'knowledge-sync',
        changed.job.jobId,
        `sync-worker-changed-${suffix}`,
        context,
      ),
    ).toBe('succeeded');
    const changedSource = await models.KnowledgeSource.findOne({
      workspaceId,
      connectorId: connected.id,
      externalId: 'doc_a',
      deletedAt: null,
    }).lean();
    expect(changedSource?.sourceVersion).toBe(2);
    expect(await connectors.getSyncCursor(connected.id, 'safe-token', context)).toMatchObject({
      cursor: { page: 'page:2' },
      cursorVersion: 4,
      syncRunId: changed.job.jobId,
    });
  }, 60_000);
});
