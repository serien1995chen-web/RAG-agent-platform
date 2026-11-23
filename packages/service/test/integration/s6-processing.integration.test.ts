import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MinioKnowledgeObjectStore } from '../../../../sdk/storage/src/index';
import { BullMqQueueAdapter } from '@kb/dal';
import { KnowledgeOutboxDispatcher } from '../../src/shared/persistence/knowledge/outbox';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import {
  KNOWLEDGE_VECTOR_PROFILES,
  KnowledgeVectorRepository,
  ensurePgvectorDdl,
} from '../../src/shared/persistence/pgvector';
import { S06ProcessingApplication } from '../../src/modules/knowledge/application/s06-processing.application';
import { S5ProcessingApplication } from '../../src/modules/knowledge/application/s5-processing.application';
import { KnowledgeFullTextRepository } from '../../src/modules/knowledge/repository/fulltext.repository';
import { KnowledgeJobExecutionRepository } from '../../src/modules/knowledge/repository/job-execution.repository';
import { KnowledgeSegmentIndexRepository } from '../../src/modules/knowledge/repository/segment-index.repository';
import { S6ProcessingRepository } from '../../src/modules/knowledge/repository/s06-processing.repository';
import { S5ArtifactRepository } from '../../src/modules/knowledge/repository/s5-artifact.repository';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s6_chain_${suffix}`;
const knowledgeSpaceId = new mongoose.Types.ObjectId();
const sourceId = new mongoose.Types.ObjectId();
const parentJobId = new mongoose.Types.ObjectId();
const outboxEventId = new mongoose.Types.ObjectId();
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s6_chain_${suffix}`,
  requestId: `req_s6_chain_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
};

let connection: mongoose.Connection;
let pool: Pool;
let objectStore: MinioKnowledgeObjectStore;
let processing: S06ProcessingApplication;
let redis: Redis;
let queueAdapter: BullMqQueueAdapter;
let segmentIndexes: KnowledgeSegmentIndexRepository;
let capturedParseMetadata: Record<string, unknown> | undefined;
const redisPrefix = `kb-s6-chain-${suffix}`;
const modelCatalog = {
  async listModels() {
    return [
      {
        modelId: 's6-embedding-768',
        displayName: 'S6 embedding',
        type: 'embedding' as const,
        capabilities: ['text-embedding', 'dimension:768'],
        dimension: 768 as const,
        authorized: true,
      },
    ];
  },
};

beforeAll(async () => {
  const mongoUri = new URL(requiredEnv('KB_TEST_MONGO_URI'));
  if (mongoUri.hostname === '127.0.0.1' || mongoUri.hostname === 'localhost') {
    mongoUri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(mongoUri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  pool = new Pool({ connectionString: requiredEnv('KB_TEST_PG_URL'), max: 4 });
  await ensurePgvectorDdl(pool);
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
    knowledgeSpaceId: String(knowledgeSpaceId),
    requestId: context.requestId,
    traceId: context.traceId,
  });
  const models = registerKnowledgeModels(connection);
  const now = new Date();
  await models.KnowledgeSource.create({
    _id: sourceId,
    workspaceId,
    knowledgeSpaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    directoryId: null,
    kind: 'url',
    name: 's6-chain-page',
    externalId: null,
    connectorId: null,
    blobRefId: new mongoose.Types.ObjectId(),
    originalUrl: 'https://public.example.test/docs',
    mimeType: 'text/html',
    sizeBytes: 32,
    contentHash: 'initial',
    parseProvider: 'liteparse',
    processingStatus: 'queued',
    sourceVersion: 1,
    searchEnabled: true,
    permissionState: 'disabled',
    permissionRevision: 0,
    ownershipMemberId: context.memberId,
    metadata: {
      originalUrl: 'https://public.example.test/docs',
      selector: 'main',
      urlHash: 's6-chain-url-hash',
    },
    tagValues: [],
  });
  await models.KnowledgeJob.create({
    _id: parentJobId,
    workspaceId,
    knowledgeSpaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    kind: 'import',
    resourceType: 'job',
    resourceId: String(parentJobId),
    status: 'queued',
    priority: 5,
    idempotencyKey: `s6-chain-import-${suffix}`,
    inputSnapshot: {
      sourceIds: [String(sourceId)],
      configurationHash: 'cfg',
      chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
      requestHash: 'request-hash',
    },
    progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
    attempts: 0,
    maxAttempts: 3,
    attemptEpoch: 0,
    fencingToken: 'unassigned',
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    availableAt: now,
    cancelRequestedAt: null,
    pausedAt: null,
    error: null,
    result: null,
    expiresAt: new Date(now.getTime() + 86_400_000),
  });
  await models.KnowledgeOutboxEvent.create({
    _id: outboxEventId,
    workspaceId,
    knowledgeSpaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    eventKey: `s6-chain-${suffix}`,
    eventType: 'import.submit',
    aggregateType: 'job',
    aggregateId: String(parentJobId),
    payload: {
      queue: 'knowledge-import',
      parentJobId: String(parentJobId),
      sourceIds: [String(sourceId)],
    },
    status: 'published',
    attempts: 1,
    availableAt: now,
    publishedAt: now,
    error: null,
    expiresAt: new Date(now.getTime() + 86_400_000),
  });
  const jobs = new KnowledgeJobExecutionRepository(connection);
  segmentIndexes = new KnowledgeSegmentIndexRepository(connection, jobs, modelCatalog);
  const artifacts = new S5ArtifactRepository(connection, {
    provider: objectStore.provider,
    bucket: objectStore.bucket,
    async putObject(input, tenant) {
      const result = await objectStore.putObject(
        {
          key: input.key,
          body: input.body,
          sizeBytes: input.body.byteLength,
          contentType: input.contentType,
          metadata: { purpose: input.purpose, sha256: input.sha256 },
          workspaceId: input.workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
        },
        {
          workspaceId: tenant.workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
          requestId: tenant.requestId,
          traceId: tenant.traceId,
        },
      );
      return {
        key: result.key,
        size: result.size,
        etag: result.etag,
        sha256: result.sha256,
      };
    },
  });
  processing = new S06ProcessingApplication({
    jobs,
    store: new S6ProcessingRepository(connection),
    artifacts,
    processing: new S5ProcessingApplication(),
    vectors: new KnowledgeVectorRepository(pool),
    fulltext: new KnowledgeFullTextRepository(connection),
    models: modelCatalog,
    bindings: {
      async list() {
        return [
          {
            modelType: 'embedding',
            modelId: 's6-embedding-768',
            displayName: 'S6 embedding',
            requiredCapabilities: ['text-embedding', 'dimension:768'],
            status: 'active',
          },
        ];
      },
    },
    synonymVersion: {
      async getPublishedFileVersion() {
        return 7;
      },
    },
    caption: {
      async execute() {
        return { result: { partial: false }, value: new mongoose.Types.ObjectId().toString() };
      },
      async markFinalFailure() {
        return undefined;
      },
      async processAsset() {
        return { segmentId: new mongoose.Types.ObjectId().toString(), partial: false };
      },
    },
    port: {
      async parse(input) {
        capturedParseMetadata = input.metadata;
        return {
          format: 'text',
          rawText: 'Refund requests are processed in five business days.',
          pages: [
            {
              pageNumber: 1,
              text: 'Refund requests are processed in five business days.',
              assets: [],
            },
          ],
          assets: [],
          diagnostics: [],
          scanRequired: false,
          imageRefs: [],
          contentHash: 'sha256:fixture',
          parserVersion: 'fixture-parser@1',
          configHash: 'fixture-config',
        };
      },
      async embed() {
        return [Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0))];
      },
      async dispatchOutbox() {
        return true;
      },
    },
  });
  redis = new Redis(requiredEnv('KB_TEST_REDIS_URL'), { maxRetriesPerRequest: null });
  queueAdapter = new BullMqQueueAdapter({ connection: redis, prefix: redisPrefix });
}, 60_000);

afterAll(async () => {
  if (connection) {
    const models = registerKnowledgeModels(connection);
    const refs = await models.KnowledgeObjectRef.find({ workspaceId }).lean();
    for (const ref of refs) {
      try {
        await objectStore.deleteObject(ref.objectKey, {
          workspaceId,
          knowledgeSpaceId: String(ref.knowledgeSpaceId),
          requestId: context.requestId,
          traceId: context.traceId,
        });
      } catch {
        // Cleanup is best effort; the unique workspace namespace prevents collisions.
      }
    }
    for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
      await connection.models[entry.modelName]?.deleteMany({ workspaceId });
    }
    await connection.close();
  }
  if (pool) {
    for (const profile of KNOWLEDGE_VECTOR_PROFILES) {
      await pool.query(`DELETE FROM ${profile.tableName} WHERE workspace_id = $1`, [workspaceId]);
    }
    await pool.end();
  }
  if (queueAdapter) await queueAdapter.close();
  if (redis) await redis.quit();
});

describe('S6 C1/C2/C3 processing chain', () => {
  it('fans a multi-image Source out to one caption job per image', async () => {
    const models = registerKnowledgeModels(connection);
    const imageSourceId = new mongoose.Types.ObjectId();
    const imageJobId = new mongoose.Types.ObjectId();
    const imageOutboxId = new mongoose.Types.ObjectId();
    const firstImageId = new mongoose.Types.ObjectId();
    const secondImageId = new mongoose.Types.ObjectId();
    const now = new Date();
    await models.KnowledgeSource.create({
      _id: imageSourceId,
      workspaceId,
      knowledgeSpaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      directoryId: null,
      kind: 'image',
      name: '产品截图',
      externalId: null,
      connectorId: null,
      blobRefId: firstImageId,
      mimeType: 'application/octet-stream',
      sizeBytes: 2,
      contentHash: 'image-set',
      parseProvider: 'liteparse',
      processingStatus: 'queued',
      sourceVersion: 1,
      searchEnabled: true,
      permissionState: 'disabled',
      permissionRevision: 0,
      ownershipMemberId: context.memberId,
      metadata: {
        imageCount: 2,
        imageBlobRefIds: [String(firstImageId), String(secondImageId)],
      },
      tagValues: [],
    });
    await models.KnowledgeJob.create({
      _id: imageJobId,
      workspaceId,
      knowledgeSpaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'import',
      resourceType: 'space',
      resourceId: String(knowledgeSpaceId),
      status: 'queued',
      priority: 5,
      idempotencyKey: `multi-image-import-${suffix}`,
      inputSnapshot: {
        sourceIds: [String(imageSourceId)],
        sourceVersions: { [String(imageSourceId)]: 1 },
        configurationHash: 'image-config',
        importKind: 'images',
        chunkingConfigSnapshot: { trainingType: 'imageParse', chunkSettingMode: 'auto' },
      },
      progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
      attempts: 0,
      maxAttempts: 3,
      attemptEpoch: 0,
      fencingToken: 'unassigned',
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      availableAt: now,
      cancelRequestedAt: null,
      pausedAt: null,
      error: null,
      result: null,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    await models.KnowledgeOutboxEvent.create({
      _id: imageOutboxId,
      workspaceId,
      knowledgeSpaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      eventKey: `multi-image-${suffix}`,
      eventType: 'import.submit',
      aggregateType: 'job',
      aggregateId: String(imageJobId),
      payload: {
        queue: 'knowledge-import',
        parentJobId: String(imageJobId),
        sourceIds: [String(imageSourceId)],
        importKind: 'images',
      },
      status: 'published',
      attempts: 1,
      availableAt: now,
      publishedAt: now,
      error: null,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    expect(
      await processing.handleImport(String(imageOutboxId), `worker-image-${suffix}`, context),
    ).toBe('succeeded');
    const captionJobs = await models.KnowledgeJob.find({
      workspaceId,
      kind: 'caption',
      resourceId: String(imageSourceId),
    })
      .sort({ 'inputSnapshot.imageOrder': 1 })
      .lean();
    expect(captionJobs).toHaveLength(2);
    expect(
      captionJobs.map((job) => ({
        imageBlobRefId: job.inputSnapshot.imageBlobRefId,
        imageOrder: job.inputSnapshot.imageOrder,
        imageCount: job.inputSnapshot.imageCount,
      })),
    ).toEqual([
      {
        imageBlobRefId: String(firstImageId),
        imageOrder: 0,
        imageCount: 2,
      },
      {
        imageBlobRefId: String(secondImageId),
        imageOrder: 1,
        imageCount: 2,
      },
    ]);
    for (const job of captionJobs) {
      expect(
        await processing.handleQueue(
          'knowledge-caption',
          String(job._id),
          `worker-image-${suffix}`,
          context,
        ),
      ).toBe('succeeded');
    }
    expect(await models.KnowledgeSource.findById(imageSourceId).lean()).toMatchObject({
      processingStatus: 'ready',
    });
  });

  it('fans out parent, parses through S5, indexes vector/fulltext and aggregates', async () => {
    const importOutcome = await processing.handleImport(
      String(outboxEventId),
      `worker-${suffix}`,
      context,
    );
    expect(importOutcome).toBe('succeeded');
    const models = registerKnowledgeModels(connection);
    const parseJob = await models.KnowledgeJob.findOne({
      workspaceId,
      kind: 'parse',
      'inputSnapshot.rootJobId': String(parentJobId),
    }).lean();
    expect(parseJob).toBeTruthy();
    const parseOutcome = await processing.handleQueue(
      'knowledge-parse',
      String(parseJob!._id),
      `worker-${suffix}`,
      context,
    );
    expect(parseOutcome).toBe('succeeded');
    expect(capturedParseMetadata).toMatchObject({
      originalUrl: 'https://public.example.test/docs',
      selector: 'main',
      urlHash: 's6-chain-url-hash',
    });
    const indexJob = await models.KnowledgeJob.findOne({
      workspaceId,
      kind: 'index',
      'inputSnapshot.rootJobId': String(parentJobId),
    }).lean();
    expect(indexJob).toBeTruthy();
    expect(
      await processing.handleQueue(
        'knowledge-index',
        String(indexJob!._id),
        `worker-${suffix}`,
        context,
      ),
    ).toBe('succeeded');
    const segment = await models.KnowledgeSegment.findOne({ workspaceId, sourceId }).lean();
    expect(segment?.indexStatus).toBe('indexed');
    expect(segment?.synonymVersion).toBe(7);
    expect(segment?.fullTextTokens.length).toBeGreaterThan(0);
    expect(segment?.indexes[0]).toMatchObject({
      dimension: 768,
      storageType: 'vector',
      modelId: 's6-embedding-768',
    });
    const vectors = await pool.query(
      'SELECT profile_id, dimension FROM knowledge_vector_profiles WHERE dimension = 768 LIMIT 1',
    );
    expect(vectors.rows).toHaveLength(1);
    const rows = await pool.query(
      'SELECT id, version FROM knowledge_segment_vectors_768 WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(rows.rows).toHaveLength(1);
    const parent = await models.KnowledgeJob.findById(parentJobId).lean();
    expect(parent?.status).toBe('succeeded');
    expect(parent?.result).toMatchObject({ partial: false });
    const source = await models.KnowledgeSource.findById(sourceId).lean();
    expect(source?.processingStatus).toBe('ready');
    const repository = new KnowledgeVectorRepository(pool);
    const activeCleanup = await repository.cleanupUnreferenced(
      {
        workspaceId,
        activeVectorIds: segment?.indexes.map((index) => index.vectorId) ?? [],
        olderThan: new Date(Date.now() + 1_000),
        batchSize: 500,
      },
      context,
    );
    expect(activeCleanup.deleted).toBe(0);
    const cleanup = await repository.cleanupUnreferenced(
      {
        workspaceId,
        activeVectorIds: [],
        olderThan: new Date(Date.now() + 1_000),
        batchSize: 500,
      },
      context,
    );
    expect(cleanup.deleted).toBe(1);
    const cleaned = await pool.query(
      'SELECT id FROM knowledge_segment_vectors_768 WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(cleaned.rows).toHaveLength(0);
  }, 60_000);

  it('delivers Outbox events through real BullMQ import, parse and index workers', async () => {
    const models = registerKnowledgeModels(connection);
    const sourceId = new mongoose.Types.ObjectId();
    const parentJobId = new mongoose.Types.ObjectId();
    const now = new Date();
    await models.KnowledgeSource.create({
      _id: sourceId,
      workspaceId,
      knowledgeSpaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      directoryId: null,
      kind: 'text',
      name: 'bullmq-chain.txt',
      externalId: null,
      connectorId: null,
      blobRefId: new mongoose.Types.ObjectId(),
      originalUrl: null,
      mimeType: 'text/plain',
      sizeBytes: 32,
      contentHash: 'initial',
      parseProvider: 'liteparse',
      processingStatus: 'queued',
      sourceVersion: 1,
      searchEnabled: true,
      permissionState: 'disabled',
      permissionRevision: 0,
      ownershipMemberId: context.memberId,
      metadata: {},
      tagValues: [],
    });
    await models.KnowledgeJob.create({
      _id: parentJobId,
      workspaceId,
      knowledgeSpaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'import',
      resourceType: 'job',
      resourceId: String(parentJobId),
      status: 'queued',
      priority: 5,
      idempotencyKey: `s6-bullmq-import-${suffix}`,
      inputSnapshot: {
        sourceIds: [String(sourceId)],
        configurationHash: 'cfg',
        chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
        requestHash: 'request-hash',
      },
      progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
      attempts: 0,
      maxAttempts: 3,
      attemptEpoch: 0,
      fencingToken: 'unassigned',
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      availableAt: now,
      cancelRequestedAt: null,
      pausedAt: null,
      error: null,
      result: null,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    await models.KnowledgeOutboxEvent.create({
      workspaceId,
      knowledgeSpaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      eventKey: `s6-bullmq-${suffix}`,
      eventType: 'import.submit',
      aggregateType: 'job',
      aggregateId: String(parentJobId),
      payload: {
        queue: 'knowledge-import',
        parentJobId: String(parentJobId),
        sourceIds: [String(sourceId)],
      },
      status: 'pending',
      attempts: 0,
      availableAt: now,
      publishedAt: null,
      error: null,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    const workers = [
      new Worker(
        'knowledge-import',
        async (job) =>
          processing.handleImport(
            String((job.data as { outboxEventId: string }).outboxEventId),
            `bullmq-worker-${suffix}`,
            context,
          ),
        { connection: redis, prefix: redisPrefix },
      ),
      new Worker(
        'knowledge-parse',
        async (job) =>
          processing.handleQueue(
            'knowledge-parse',
            String((job.data as { payload: { jobId: string } }).payload.jobId),
            `bullmq-worker-${suffix}`,
            context,
          ),
        { connection: redis, prefix: redisPrefix },
      ),
      new Worker(
        'knowledge-index',
        async (job) =>
          processing.handleQueue(
            'knowledge-index',
            String((job.data as { payload: { jobId: string } }).payload.jobId),
            `bullmq-worker-${suffix}`,
            context,
          ),
        { connection: redis, prefix: redisPrefix },
      ),
    ];
    try {
      await Promise.all(workers.map((worker) => worker.waitUntilReady()));
      const dispatcher = new KnowledgeOutboxDispatcher(connection, queueAdapter);
      let terminal = false;
      for (let attempt = 0; attempt < 200 && !terminal; attempt += 1) {
        for (let index = 0; index < 10; index += 1) {
          const dispatched = await dispatcher.dispatchOnce(context);
          if (!dispatched.dispatched) break;
        }
        const parent = await models.KnowledgeJob.findById(parentJobId).lean();
        terminal = ['succeeded', 'failed', 'dead_letter', 'cancelled'].includes(
          parent?.status ?? '',
        );
        if (!terminal) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const parent = await models.KnowledgeJob.findById(parentJobId).lean();
      expect(parent?.status).toBe('succeeded');
      const segment = await models.KnowledgeSegment.findOne({ workspaceId, sourceId }).lean();
      expect(segment?.indexStatus).toBe('indexed');
      expect(segment?.fullTextTokens.length).toBeGreaterThan(0);
      const vector = await pool.query(
        'SELECT id FROM knowledge_segment_vectors_768 WHERE workspace_id = $1 AND segment_id = $2',
        [workspaceId, String(segment?._id)],
      );
      expect(vector.rows.length).toBe(1);
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }
  }, 60_000);

  it('L1-B05-DATA-004-P01 creates a traceable index Job and reaches vector/full-text projection', async () => {
    const created = await segmentIndexes.createSegment(
      String(sourceId),
      {
        question: 'B05 direct insert searchable text',
        answer: '',
        segmentType: 'chunk',
        searchEnabled: true,
        metadata: {},
      },
      context,
    );
    const jobId = created.jobId;
    const outcome = await processing.handleQueue(
      'knowledge-index',
      jobId,
      `b05-index-worker-${suffix}`,
      context,
    );
    expect(outcome).toBe('succeeded');
    const models = registerKnowledgeModels(connection);
    const segment = await models.KnowledgeSegment.findOne({
      workspaceId,
      question: 'B05 direct insert searchable text',
    }).lean();
    expect(segment).toMatchObject({
      indexStatus: 'indexed',
      indexErrorCode: null,
    });
    expect(segment?.fullTextTokens.length).toBeGreaterThan(0);
    const vector = await pool.query(
      'SELECT id FROM knowledge_segment_vectors_768 WHERE workspace_id = $1 AND segment_id = $2',
      [workspaceId, String(segment?._id)],
    );
    expect(vector.rows).toHaveLength(1);
    const job = await models.KnowledgeJob.findById(jobId).lean();
    expect(job?.status).toBe('succeeded');
  }, 30_000);

  it('TEST-X-PERMISSION-SWITCH L1-B13-A-TRAIN-002-A02 refuses to commit an index after write access changes to read', async () => {
    const models = registerKnowledgeModels(connection);
    const aclSourceId = new mongoose.Types.ObjectId();
    const aclSpaceId = new mongoose.Types.ObjectId();
    await models.KnowledgeSource.create({
      _id: aclSourceId,
      workspaceId,
      knowledgeSpaceId: aclSpaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      directoryId: null,
      kind: 'text',
      name: 'b13-permission-switch',
      externalId: null,
      connectorId: null,
      blobRefId: null,
      originalUrl: null,
      mimeType: 'text/plain',
      sizeBytes: 0,
      contentHash: 'b13-permission-switch',
      parseProvider: 'liteparse',
      processingStatus: 'ready',
      sourceVersion: 1,
      searchEnabled: true,
      permissionState: 'independent',
      permissionRevision: 1,
      aclSnapshotVersion: 1,
      ownershipMemberId: context.memberId,
      metadata: {},
      tagValues: [],
    });
    const acl = await models.KnowledgeResourcePermission.create({
      workspaceId,
      knowledgeSpaceId: aclSpaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      resourceType: 'source',
      resourceId: aclSourceId,
      principalType: 'member',
      principalId: context.memberId,
      permission: 'write',
      inheritMode: 'override',
      snapshotVersion: 1,
    });
    const draft = await segmentIndexes.createSegment(
      String(aclSourceId),
      {
        question: 'Permission switch must not commit',
        answer: '',
        segmentType: 'chunk',
        searchEnabled: true,
        metadata: {},
      },
      context,
    );
    await models.KnowledgeResourcePermission.updateOne(
      { _id: acl._id, workspaceId },
      { $set: { permission: 'read' }, $inc: { version: 1, snapshotVersion: 1 } },
    );
    await models.KnowledgeSource.updateOne(
      { _id: aclSourceId, workspaceId },
      { $inc: { version: 1, permissionRevision: 1 } },
    );

    const outcome = await processing.handleQueue(
      'knowledge-index',
      draft.jobId,
      `permission-switch-${suffix}`,
      context,
    );
    const segment = await models.KnowledgeSegment.findById(draft.id).lean();
    const vector = await pool.query(
      'SELECT id FROM knowledge_segment_vectors_768 WHERE workspace_id = $1 AND segment_id = $2',
      [workspaceId, draft.id],
    );
    expect.soft(outcome).toBe('dead_letter');
    expect.soft(segment?.indexStatus).toBe('error');
    expect.soft(vector.rows).toHaveLength(0);
  }, 30_000);
});
