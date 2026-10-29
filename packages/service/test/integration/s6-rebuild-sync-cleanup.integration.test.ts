import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MinioKnowledgeObjectStore } from '../../../../sdk/storage/src/index';
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
import { S6ProcessingRepository } from '../../src/modules/knowledge/repository/s06-processing.repository';
import { S5ArtifactRepository } from '../../src/modules/knowledge/repository/s5-artifact.repository';
import { KnowledgeSynonymRepository } from '../../src/modules/knowledge/repository/s09-synonym.repository';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s6_rebuild_${suffix}`;
const knowledgeSpaceId = new mongoose.Types.ObjectId();
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s6_rebuild_${suffix}`,
  requestId: `req_s6_rebuild_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
};

let connection: mongoose.Connection;
let pool: Pool;
let objectStore: MinioKnowledgeObjectStore;
let jobs: KnowledgeJobExecutionRepository;
let vectors: KnowledgeVectorRepository;
let processing: S06ProcessingApplication;

function vectorFixture(): number[] {
  return Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0));
}

async function createSource(input: {
  name: string;
  status?: 'queued' | 'ready' | 'partial' | 'rebuilding';
  sourceVersion?: number;
}) {
  const models = registerKnowledgeModels(connection);
  const sourceId = new mongoose.Types.ObjectId();
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
    name: input.name,
    externalId: null,
    connectorId: null,
    blobRefId: new mongoose.Types.ObjectId(),
    originalUrl: null,
    mimeType: 'text/plain',
    sizeBytes: 32,
    contentHash: `source-${input.name}`,
    parseProvider: 'liteparse',
    processingStatus: input.status ?? 'ready',
    sourceVersion: input.sourceVersion ?? 1,
    searchEnabled: true,
    permissionState: 'disabled',
    permissionRevision: 0,
    ownershipMemberId: context.memberId,
    metadata: {},
    tagValues: [],
  });
  return sourceId;
}

async function createIndexedSegment(input: {
  sourceId: mongoose.Types.ObjectId;
  order: number;
  text: string;
}) {
  const models = registerKnowledgeModels(connection);
  const segmentId = new mongoose.Types.ObjectId();
  const contentHash = createHash('sha256').update(input.text, 'utf8').digest('hex');
  const inserted = await vectors.insert(
    [
      {
        workspaceId,
        knowledgeSpaceId: String(knowledgeSpaceId),
        sourceId: String(input.sourceId),
        segmentId: String(segmentId),
        indexId: 'default',
        embeddingModelId: 's6-embedding-768',
        dimension: 768,
        vector: vectorFixture(),
        searchEnabled: true,
        contentHash,
        version: 3,
      },
    ],
    context,
  );
  await models.KnowledgeSegment.create({
    _id: segmentId,
    workspaceId,
    knowledgeSpaceId,
    version: 2,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    sourceId: input.sourceId,
    sourceVersion: 1,
    searchEnabled: true,
    order: input.order,
    question: input.text,
    answer: input.text,
    content: input.text,
    fullTextTokens: input.text,
    fullTextVersion: 3,
    metadata: { title: input.text },
    history: [],
    indexes: [
      {
        indexId: 'default',
        type: 'default',
        modelId: 's6-embedding-768',
        dimension: 768,
        storageType: 'vector',
        vectorProfile: 'knowledge_segment_vectors_768',
        vectorId: inserted.vectorIds[0]!,
        text: input.text,
        version: 3,
      },
    ],
    indexStatus: 'indexed',
    indexErrorCode: null,
    imageBlobRefId: null,
    imageDescription: null,
    synonymVersion: 0,
  });
  return { segmentId, vectorId: inserted.vectorIds[0]! };
}

async function createRawJob(input: {
  kind: 'sync' | 'cleanup' | 'caption';
  resourceType: 'space' | 'source';
  resourceId: string;
  inputSnapshot: Record<string, unknown>;
}) {
  const models = registerKnowledgeModels(connection);
  const jobId = new mongoose.Types.ObjectId();
  const now = new Date();
  await models.KnowledgeJob.create({
    _id: jobId,
    workspaceId,
    knowledgeSpaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    kind: input.kind,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    status: 'queued',
    priority: 5,
    idempotencyKey: `${input.kind}-${jobId}`,
    inputSnapshot: input.inputSnapshot,
    progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
    attempts: 0,
    maxAttempts: 5,
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
    expiresAt: new Date(now.getTime() + 180 * 86_400_000),
  });
  return String(jobId);
}

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
  jobs = new KnowledgeJobExecutionRepository(connection);
  vectors = new KnowledgeVectorRepository(pool);
  const synonyms = new KnowledgeSynonymRepository(connection);
  const artifacts = new S5ArtifactRepository(connection, {
    provider: objectStore.provider,
    bucket: objectStore.bucket,
    async putObject(input, tenant) {
      const stored = await objectStore.putObject(
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
        key: stored.key,
        size: stored.size,
        etag: stored.etag,
        sha256: stored.sha256,
      };
    },
  });
  processing = new S06ProcessingApplication({
    jobs,
    store: new S6ProcessingRepository(connection),
    artifacts,
    processing: new S5ProcessingApplication(),
    vectors,
    fulltext: new KnowledgeFullTextRepository(connection),
    models: {
      async listModels() {
        return [
          {
            modelId: 's6-embedding-768',
            displayName: 'S6 embedding',
            type: 'embedding',
            capabilities: ['text-embedding', 'dimension:768'],
            dimension: 768,
            authorized: true,
          },
        ];
      },
    },
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
    synonymCleanup: synonyms,
    port: {
      async parse() {
        throw new Error('parse is not used by rebuild/sync/cleanup tests');
      },
      async embed() {
        return [vectorFixture()];
      },
      async dispatchOutbox() {
        return false;
      },
    },
  });
}, 60_000);

afterAll(async () => {
  if (connection) {
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
});

describe('S6 rebuild, sync and cleanup', () => {
  beforeEach(async () => {
    for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
      await connection.models[entry.modelName]?.deleteMany({ workspaceId });
    }
    for (const profile of KNOWLEDGE_VECTOR_PROFILES) {
      await pool.query(`DELETE FROM ${profile.tableName} WHERE workspace_id = $1`, [workspaceId]);
    }
  });

  it('writes all four embedding dimensions to their matching pgvector profile', async () => {
    for (const dimension of [768, 1024, 1536, 3072] as const) {
      const vectorId = (
        await vectors.insert(
          [
            {
              workspaceId,
              knowledgeSpaceId: String(knowledgeSpaceId),
              sourceId: String(new mongoose.Types.ObjectId()),
              segmentId: String(new mongoose.Types.ObjectId()),
              indexId: `profile-${dimension}`,
              embeddingModelId: `s6-embedding-${dimension}`,
              dimension,
              vector: Array.from({ length: dimension }, (_, index) => (index === 0 ? 1 : 0)),
              searchEnabled: true,
              contentHash: `profile-${dimension}-${suffix}`,
              version: 1,
            },
          ],
          context,
        )
      ).vectorIds[0]!;
      const profile = vectors.listProfiles().find((candidate) => candidate.dimension === dimension);
      expect(profile).toBeTruthy();
      const row = await pool.query<{ norm: number; storage_type: string }>(
        `SELECT norm, pg_typeof(embedding)::text AS storage_type
         FROM ${profile!.tableName}
         WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, vectorId],
      );
      expect(row.rows[0]).toMatchObject({
        norm: 1,
        storage_type: dimension === 3072 ? 'halfvec' : 'vector',
      });
      for (const other of KNOWLEDGE_VECTOR_PROFILES) {
        if (other.tableName === profile!.tableName) continue;
        const crossTable = await pool.query(
          `SELECT id FROM ${other.tableName} WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, vectorId],
        );
        expect(crossTable.rows).toHaveLength(0);
      }
    }
    await expect(
      vectors.insert(
        [
          {
            workspaceId,
            knowledgeSpaceId: String(knowledgeSpaceId),
            sourceId: String(new mongoose.Types.ObjectId()),
            segmentId: String(new mongoose.Types.ObjectId()),
            indexId: 'zero',
            embeddingModelId: 's6-embedding-768',
            dimension: 768,
            vector: Array.from({ length: 768 }, () => 0),
            searchEnabled: true,
            contentHash: `zero-${suffix}`,
            version: 1,
          },
        ],
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });

  it('keeps old pointers until every rebuild child switches, then cleans only expired inactive vectors', async () => {
    const models = registerKnowledgeModels(connection);
    const sourceId = await createSource({ name: 'rebuild.txt' });
    const first = await createIndexedSegment({
      sourceId,
      order: 0,
      text: 'First rebuild segment.',
    });
    const second = await createIndexedSegment({
      sourceId,
      order: 1,
      text: 'Second rebuild segment.',
    });
    const root = await jobs.createSourceRebuild(
      {
        kind: 'rebuild',
        resourceType: 'source',
        resourceId: String(sourceId),
        knowledgeSpaceId: String(knowledgeSpaceId),
        sourceVersion: 1,
        inputSnapshot: {
          sourceId: String(sourceId),
          sourceVersion: 1,
          reason: 'manual',
          expectedSegmentVersions: [2, 2],
        },
        priority: 5,
        idempotencyKey: `rebuild-${suffix}-source`,
      },
      context,
    );
    expect((await models.KnowledgeSource.findById(sourceId).lean())?.processingStatus).toBe(
      'rebuilding',
    );
    await expect(
      jobs.createSourceRebuild(
        {
          kind: 'rebuild',
          resourceType: 'source',
          resourceId: String(sourceId),
          knowledgeSpaceId: String(knowledgeSpaceId),
          sourceVersion: 1,
          inputSnapshot: {
            sourceId: String(sourceId),
            sourceVersion: 1,
            reason: 'manual',
            expectedSegmentVersions: [2, 2],
          },
          priority: 5,
          idempotencyKey: `rebuild-${suffix}-concurrent`,
        },
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });

    expect(
      await processing.handleQueue(
        'knowledge-rebuild',
        String(root.jobId),
        `rebuild-worker-${suffix}`,
        context,
      ),
    ).toBe('succeeded');
    const rootWaiting = await jobs.getRaw(String(root.jobId), context);
    expect(rootWaiting.status).toBe('running');
    expect(rootWaiting.progress.stage).toBe('waiting_children');
    const childJobs = await models.KnowledgeJob.find({
      workspaceId,
      kind: 'index',
      'inputSnapshot.rootJobId': String(root.jobId),
    }).lean();
    expect(childJobs).toHaveLength(2);
    const beforeChildren = await models.KnowledgeSegment.find({ workspaceId, sourceId }).lean();
    expect(beforeChildren.map((segment) => segment.indexes[0]?.vectorId).sort()).toEqual(
      [first.vectorId, second.vectorId].sort(),
    );

    const firstChild = childJobs.find((job) => String(job.resourceId) === String(first.segmentId))!;
    expect(
      await processing.handleQueue(
        'knowledge-index',
        String(firstChild._id),
        `index-worker-${suffix}`,
        context,
      ),
    ).toBe('succeeded');
    expect((await jobs.getRaw(String(root.jobId), context)).status).toBe('running');
    const secondChild = childJobs.find(
      (job) => String(job.resourceId) === String(second.segmentId),
    )!;
    expect(
      await processing.handleQueue(
        'knowledge-index',
        String(secondChild._id),
        `index-worker-${suffix}`,
        context,
      ),
    ).toBe('succeeded');

    expect((await jobs.getRaw(String(root.jobId), context)).status).toBe('succeeded');
    expect((await models.KnowledgeSource.findById(sourceId).lean())?.processingStatus).toBe(
      'ready',
    );
    const rebuilt = await models.KnowledgeSegment.find({ workspaceId, sourceId }).lean();
    expect(rebuilt.every((segment) => segment.fullTextVersion === 4)).toBe(true);
    expect(rebuilt.every((segment) => segment.indexStatus === 'indexed')).toBe(true);
    expect(rebuilt.map((segment) => segment.indexes[0]?.vectorId)).not.toEqual(
      expect.arrayContaining([first.vectorId, second.vectorId]),
    );

    const allVectors = await pool.query<{ id: string }>(
      'SELECT id FROM knowledge_segment_vectors_768 WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(allVectors.rows).toHaveLength(4);
    await pool.query(
      `UPDATE knowledge_segment_vectors_768
       SET updated_at = now() - interval '31 days'
       WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
      [workspaceId, [first.vectorId, second.vectorId]],
    );
    const orphanSegmentId = new mongoose.Types.ObjectId();
    const recentOrphan = await vectors.insert(
      [
        {
          workspaceId,
          knowledgeSpaceId: String(knowledgeSpaceId),
          sourceId: String(sourceId),
          segmentId: String(orphanSegmentId),
          indexId: 'default',
          embeddingModelId: 's6-embedding-768',
          dimension: 768,
          vector: vectorFixture(),
          searchEnabled: true,
          contentHash: `recent-${suffix}`,
          version: 1,
        },
      ],
      context,
    );
    await pool.query(
      `UPDATE knowledge_segment_vectors_768
       SET updated_at = now() - interval '29 days'
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, recentOrphan.vectorIds[0]],
    );
    const cleanupJobId = await createRawJob({
      kind: 'cleanup',
      resourceType: 'space',
      resourceId: String(knowledgeSpaceId),
      inputSnapshot: { retentionDays: 30, batchSize: 500 },
    });
    expect(
      await processing.handleQueue(
        'knowledge-cleanup',
        cleanupJobId,
        `cleanup-worker-${suffix}`,
        context,
      ),
    ).toBe('succeeded');
    const cleaned = await pool.query<{ id: string }>(
      'SELECT id FROM knowledge_segment_vectors_768 WHERE workspace_id = $1 ORDER BY id',
      [workspaceId],
    );
    expect(cleaned.rows.map((row) => row.id)).not.toContain(first.vectorId);
    expect(cleaned.rows.map((row) => row.id)).not.toContain(second.vectorId);
    expect(cleaned.rows.map((row) => row.id)).toContain(recentOrphan.vectorIds[0]);
    expect(cleaned.rows).toHaveLength(3);
  }, 60_000);

  it('retains switched synonym vectors until their 30 day candidate boundary', async () => {
    const models = registerKnowledgeModels(connection);
    const sourceId = await createSource({ name: 'synonym-cleanup.txt', status: 'ready' });
    const now = new Date();
    const inserted = await vectors.insert(
      [
        {
          workspaceId,
          knowledgeSpaceId: String(knowledgeSpaceId),
          sourceId: String(sourceId),
          segmentId: String(new mongoose.Types.ObjectId()),
          indexId: 'default',
          embeddingModelId: 's6-embedding-768',
          dimension: 768,
          vector: vectorFixture(),
          searchEnabled: true,
          contentHash: `retained-0-${suffix}`,
          version: 4,
        },
        {
          workspaceId,
          knowledgeSpaceId: String(knowledgeSpaceId),
          sourceId: String(sourceId),
          segmentId: String(new mongoose.Types.ObjectId()),
          indexId: 'default',
          embeddingModelId: 's6-embedding-768',
          dimension: 768,
          vector: vectorFixture(),
          searchEnabled: true,
          contentHash: `retained-29-${suffix}`,
          version: 1,
        },
        {
          workspaceId,
          knowledgeSpaceId: String(knowledgeSpaceId),
          sourceId: String(sourceId),
          segmentId: String(new mongoose.Types.ObjectId()),
          indexId: 'default',
          embeddingModelId: 's6-embedding-768',
          dimension: 768,
          vector: vectorFixture(),
          searchEnabled: true,
          contentHash: `eligible-30-${suffix}`,
          version: 2,
        },
        {
          workspaceId,
          knowledgeSpaceId: String(knowledgeSpaceId),
          sourceId: String(sourceId),
          segmentId: String(new mongoose.Types.ObjectId()),
          indexId: 'default',
          embeddingModelId: 's6-embedding-768',
          dimension: 768,
          vector: vectorFixture(),
          searchEnabled: true,
          contentHash: `eligible-31-${suffix}`,
          version: 3,
        },
      ],
      context,
    );
    await pool.query(
      `UPDATE knowledge_segment_vectors_768
       SET updated_at = now() - interval '31 days'
       WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
      [workspaceId, inserted.vectorIds],
    );
    await models.KnowledgeJob.create({
      workspaceId,
      knowledgeSpaceId,
      version: 2,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'synonym_rebuild',
      resourceType: 'synonym',
      resourceId: String(knowledgeSpaceId),
      status: 'succeeded',
      priority: 5,
      idempotencyKey: `synonym-cleanup-${suffix}`,
      inputSnapshot: { reason: 'synonym_change', fileVersion: 2 },
      progress: { stage: 'succeeded', completed: 1, total: 1, percent: 100 },
      attempts: 1,
      maxAttempts: 3,
      attemptEpoch: 1,
      fencingToken: randomUUID(),
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      availableAt: now,
      cancelRequestedAt: null,
      pausedAt: null,
      error: null,
      result: {
        cleanupCandidates: [
          {
            vectorId: inserted.vectorIds[0],
            dimension: 768,
            availableAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
          },
          {
            vectorId: inserted.vectorIds[1],
            dimension: 768,
            availableAt: new Date(now.getTime() + 86_400_000).toISOString(),
          },
          {
            vectorId: inserted.vectorIds[2],
            dimension: 768,
            availableAt: now.toISOString(),
          },
          {
            vectorId: inserted.vectorIds[3],
            dimension: 768,
            availableAt: new Date(now.getTime() - 86_400_000).toISOString(),
          },
        ],
      },
      expiresAt: new Date(now.getTime() + 180 * 86_400_000),
    });
    const cleanupJobId = await createRawJob({
      kind: 'cleanup',
      resourceType: 'space',
      resourceId: String(knowledgeSpaceId),
      inputSnapshot: { retentionDays: 30, batchSize: 500 },
    });
    expect(
      await processing.handleQueue(
        'knowledge-cleanup',
        cleanupJobId,
        `synonym-cleanup-worker-${suffix}`,
        context,
      ),
    ).toBe('succeeded');
    const remaining = await pool.query<{ id: string }>(
      'SELECT id FROM knowledge_segment_vectors_768 WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(remaining.rows.map((row) => row.id).sort()).toEqual(
      [inserted.vectorIds[0], inserted.vectorIds[1]].sort(),
    );
    const cleanup = await jobs.getRaw(cleanupJobId, context);
    expect(cleanup.result).toMatchObject({
      deleted: 2,
      synonymRetentionCandidateCount: 4,
    });
  }, 60_000);

  it('expands a space rebuild into source roots and finalizes the nested tree', async () => {
    const models = registerKnowledgeModels(connection);
    const sourceId = await createSource({ name: 'space-rebuild.txt' });
    await createIndexedSegment({
      sourceId,
      order: 0,
      text: 'Nested rebuild segment.',
    });
    const root = await jobs.create(
      {
        kind: 'rebuild',
        resourceType: 'space',
        resourceId: String(knowledgeSpaceId),
        knowledgeSpaceId: String(knowledgeSpaceId),
        inputSnapshot: { sourceIds: [String(sourceId)], reason: 'manual' },
        priority: 5,
        idempotencyKey: `space-rebuild-${suffix}`,
      },
      context,
    );
    expect(
      await processing.handleQueue(
        'knowledge-rebuild',
        String(root.jobId),
        `space-rebuild-worker-${suffix}`,
        context,
      ),
    ).toBe('succeeded');
    const sourceChild = await models.KnowledgeJob.findOne({
      workspaceId,
      kind: 'rebuild',
      'inputSnapshot.rootJobId': String(root.jobId),
      'inputSnapshot.parentJobId': String(root.jobId),
    }).lean();
    expect(sourceChild).toBeTruthy();
    expect(
      await processing.handleQueue(
        'knowledge-rebuild',
        String(sourceChild!._id),
        `source-rebuild-worker-${suffix}`,
        context,
      ),
    ).toBe('succeeded');
    const indexChild = await models.KnowledgeJob.findOne({
      workspaceId,
      kind: 'index',
      'inputSnapshot.rootJobId': String(root.jobId),
      'inputSnapshot.parentJobId': String(sourceChild!._id),
    }).lean();
    expect(indexChild).toBeTruthy();
    expect(
      await processing.handleQueue(
        'knowledge-index',
        String(indexChild!._id),
        `nested-index-worker-${suffix}`,
        context,
      ),
    ).toBe('succeeded');
    expect((await jobs.getRaw(String(sourceChild!._id), context)).status).toBe('succeeded');
    expect((await jobs.getRaw(String(root.jobId), context)).status).toBe('succeeded');
    expect((await models.KnowledgeSource.findById(sourceId).lean())?.processingStatus).toBe(
      'ready',
    );
  }, 60_000);

  it('fans out sync once without creating another Source and leaves the cursor for S4 commit', async () => {
    const models = registerKnowledgeModels(connection);
    const sourceId = await createSource({ name: 'sync.txt', status: 'queued' });
    const syncJobId = await createRawJob({
      kind: 'sync',
      resourceType: 'source',
      resourceId: String(sourceId),
      inputSnapshot: {
        sourceIds: [String(sourceId), String(sourceId)],
        connectorId: String(new mongoose.Types.ObjectId()),
        cursorVersion: 7,
      },
    });
    expect(
      await processing.handleQueue('knowledge-sync', syncJobId, `sync-worker-${suffix}`, context),
    ).toBe('succeeded');
    const waiting = await jobs.getRaw(syncJobId, context);
    expect(waiting.status).toBe('running');
    expect(waiting.progress.stage).toBe('waiting_children');
    expect(waiting.result?.cursorVersion).toBe(7);
    expect((await models.KnowledgeSource.findById(sourceId).lean())?.processingStatus).toBe(
      'parsing',
    );
    const children = await models.KnowledgeJob.find({
      workspaceId,
      kind: 'parse',
      'inputSnapshot.rootJobId': syncJobId,
    }).lean();
    expect(children).toHaveLength(1);
    expect(children[0]?.inputSnapshot.sourceVersion).toBe(1);
    expect(await models.KnowledgeSource.countDocuments({ workspaceId, name: 'sync.txt' })).toBe(1);
    expect(
      await processing.handleQueue(
        'knowledge-sync',
        syncJobId,
        `sync-duplicate-${suffix}`,
        context,
      ),
    ).toBe('retry');
    expect(
      await models.KnowledgeJob.countDocuments({
        workspaceId,
        kind: 'parse',
        'inputSnapshot.rootJobId': syncJobId,
      }),
    ).toBe(1);
  }, 60_000);

  it('does not create the removed caption placeholder step when the executor is unavailable', async () => {
    const models = registerKnowledgeModels(connection);
    const sourceId = new mongoose.Types.ObjectId();
    const captionJobId = await createRawJob({
      kind: 'caption',
      resourceType: 'source',
      resourceId: String(sourceId),
      inputSnapshot: { sourceId: String(sourceId), reason: 's8_required' },
    });
    await models.KnowledgeJob.updateOne(
      { _id: captionJobId, workspaceId },
      { $set: { maxAttempts: 1 } },
    );
    expect(
      await processing.handleQueue(
        'knowledge-caption',
        captionJobId,
        `caption-worker-${suffix}`,
        context,
      ),
    ).toBe('dead_letter');
    const captionJob = await jobs.getRaw(captionJobId, context);
    expect(captionJob.status).toBe('dead_letter');
    expect(captionJob.error).toMatchObject({
      code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
      retryable: true,
    });
    const step = await models.KnowledgeJobStep.findOne({
      workspaceId,
      jobId: captionJobId,
      stepKey: 'caption',
    }).lean();
    expect(step).toBeNull();
    const vectorRows = await pool.query(
      'SELECT id FROM knowledge_segment_vectors_768 WHERE workspace_id = $1 AND source_id = $2',
      [workspaceId, String(sourceId)],
    );
    expect(vectorRows.rows).toHaveLength(0);
  }, 60_000);
});
