import { createHash, randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { S5MockModelCatalog } from '../../src/modules/knowledge/adapter/s5-aiproxy-catalog.adapter';
import { S09S6RebuildIndexAdapter } from '../../src/modules/knowledge/adapter/s09-synonym-s6.adapter';
import { S06ProcessingApplication } from '../../src/modules/knowledge/application/s06-processing.application';
import { S5ProcessingApplication } from '../../src/modules/knowledge/application/s5-processing.application';
import { buildRebuildPlan } from '../../src/modules/knowledge/domain/s09-synonym-rebuild';
import { KnowledgeFullTextRepository } from '../../src/modules/knowledge/repository/fulltext.repository';
import { KnowledgeJobExecutionRepository } from '../../src/modules/knowledge/repository/job-execution.repository';
import { S5ModelBindingRepository } from '../../src/modules/knowledge/repository/s5-model-binding.repository';
import { S6ProcessingRepository } from '../../src/modules/knowledge/repository/s06-processing.repository';
import { KnowledgeSegmentIndexRepository } from '../../src/modules/knowledge/repository/segment-index.repository';
import { KnowledgeSynonymRepository } from '../../src/modules/knowledge/repository/s09-synonym.repository';
import { S7SearchRepository } from '../../src/modules/knowledge/repository/s7-search.repository';
import {
  KNOWLEDGE_VECTOR_PROFILES,
  KnowledgeVectorRepository,
  ensurePgvectorDdl,
} from '../../src/shared/persistence/pgvector';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

function vectorFor(dimension: 768 | 1024, seed = 0): number[] {
  return Array.from({ length: dimension }, (_, index) => (index === seed ? 1 : 0));
}

function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b14_a_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_b14_a_${suffix}`,
  requestId: `req_b14_a_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:search', 'knowledge:write', 'knowledge:manage'],
};

let connection: mongoose.Connection;
let pool: Pool;
let vectors: KnowledgeVectorRepository;
let fulltext: KnowledgeFullTextRepository;
let catalog: S5MockModelCatalog;
let bindings: S5ModelBindingRepository;
let jobs: KnowledgeJobExecutionRepository;
let processing: S06ProcessingApplication;
let segmentIndexes: KnowledgeSegmentIndexRepository;
let search: S7SearchRepository;

async function seedSpace() {
  const models = registerKnowledgeModels(connection);
  const space = await models.KnowledgeSpace.create({
    workspaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    kind: 'space',
    parentSpaceId: null,
    name: `B14 space ${suffix}`,
    normalizedName: `b14-space-${suffix}`,
    description: '',
    iconKey: 'book-open',
    ownershipMemberId: context.memberId,
    accessMode: 'workspace',
    sourceAclMode: 'enforced',
    sourcePermissionEnabled: true,
    referenceRevision: 0,
    permissionRevision: 1,
    modelBindings: {},
    defaultChunking: {},
    status: 'active',
  });
  await models.KnowledgeModelBinding.create({
    workspaceId,
    knowledgeSpaceId: space._id,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    modelType: 'embedding',
    modelId: 'mock-embedding-768',
    displayName: 'Mock embedding 768',
    requiredCapabilities: ['text-embedding', 'dimension:768'],
    status: 'active',
    activeQueryModelId: 'mock-embedding-768',
    activeQueryDimension: 768,
    authorizedAt: new Date(),
  });
  return space;
}

async function seedSource(knowledgeSpaceId: Types.ObjectId) {
  const models = registerKnowledgeModels(connection);
  const source = await models.KnowledgeSource.create({
    workspaceId,
    knowledgeSpaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    directoryId: null,
    kind: 'text',
    name: `b14-source-${suffix}.txt`,
    externalId: null,
    connectorId: null,
    blobRefId: new Types.ObjectId(),
    originalUrl: null,
    mimeType: 'text/plain',
    sizeBytes: 128,
    contentHash: `source-${suffix}`,
    parseProvider: 'liteparse',
    processingStatus: 'ready',
    sourceVersion: 1,
    searchEnabled: true,
    permissionState: 'disabled',
    permissionRevision: 0,
    ownershipMemberId: context.memberId,
    metadata: {},
    tagValues: [],
  });
  return source._id;
}

async function seedSegment(input: {
  knowledgeSpaceId: Types.ObjectId;
  sourceId: Types.ObjectId;
  order: number;
  text: string;
}) {
  const models = registerKnowledgeModels(connection);
  const segmentId = new Types.ObjectId();
  const projection = fulltext.prepare({
    segmentId: String(segmentId),
    sourceVersion: 1,
    indexVersion: 3,
    question: input.text,
    answer: input.text,
    content: input.text,
    searchEnabled: true,
  });
  const inserted = await vectors.insert(
    [
      {
        workspaceId,
        knowledgeSpaceId: String(input.knowledgeSpaceId),
        sourceId: String(input.sourceId),
        segmentId: String(segmentId),
        indexId: 'default',
        embeddingModelId: 'mock-embedding-768',
        dimension: 768,
        vector: vectorFor(768, input.order),
        searchEnabled: true,
        contentHash: contentHash(input.text),
        version: 3,
      },
    ],
    context,
  );
  await models.KnowledgeSegment.create({
    _id: segmentId,
    workspaceId,
    knowledgeSpaceId: input.knowledgeSpaceId,
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
    contentHash: contentHash(input.text),
    fullTextTokens: projection.fullTextTokens,
    fullTextVersion: projection.fullTextVersion,
    metadata: { title: input.text },
    history: [],
    indexes: [
      {
        indexId: 'default',
        type: 'default',
        modelId: 'mock-embedding-768',
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
  pool = new Pool({
    connectionString: requiredEnv('KB_TEST_PG_URL'),
    max: 4,
  });
  await ensurePgvectorDdl(pool);

  catalog = new S5MockModelCatalog();
  vectors = new KnowledgeVectorRepository(pool);
  fulltext = new KnowledgeFullTextRepository(connection);
  jobs = new KnowledgeJobExecutionRepository(connection);
  const synonyms = new KnowledgeSynonymRepository(connection);
  bindings = new S5ModelBindingRepository(connection, synonyms);
  segmentIndexes = new KnowledgeSegmentIndexRepository(connection, jobs, catalog);
  search = new S7SearchRepository(connection, catalog);
  processing = new S06ProcessingApplication({
    jobs,
    store: new S6ProcessingRepository(connection),
    artifacts: {
      async materialize() {
        throw new Error('artifact materialization is not used by B14 indexing tests');
      },
    },
    processing: new S5ProcessingApplication(),
    vectors,
    fulltext,
    models: catalog,
    bindings,
    synonymCleanup: synonyms,
    port: {
      async parse() {
        throw new Error('parse is not used by B14 indexing tests');
      },
      async embed(request) {
        return [vectorFor(request.dimension, 0)];
      },
      async dispatchOutbox() {
        return false;
      },
    },
  });
}, 60_000);

beforeEach(async () => {
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({ workspaceId });
  }
  for (const profile of KNOWLEDGE_VECTOR_PROFILES) {
    await pool.query(`DELETE FROM ${profile.tableName} WHERE workspace_id = $1`, [workspaceId]);
  }
});

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

describe('B14 vector, full-text and rebuild acceptance', () => {
  it('L1-B14-TRAIN-006-N01 rejects selecting the already active embedding model', async () => {
    const space = await seedSpace();
    const current = await bindings.list(String(space._id), context);
    const embedding = current.find((binding) => binding.modelType === 'embedding')!;

    await expect(
      bindings.replace(String(space._id), space.version, [embedding], context),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });

  it('L1-B14-TRAIN-003/004/006-P01 keeps the old profile during rebuild and switches once after all children', async () => {
    const models = registerKnowledgeModels(connection);
    const space = await seedSpace();
    const sourceId = await seedSource(space._id);
    const segments = await Promise.all([
      seedSegment({
        knowledgeSpaceId: space._id,
        sourceId,
        order: 0,
        text: '退款 到账 需要 五个 工作日',
      }),
      seedSegment({
        knowledgeSpaceId: space._id,
        sourceId,
        order: 1,
        text: 'refund settlement takes five business days',
      }),
      seedSegment({
        knowledgeSpaceId: space._id,
        sourceId,
        order: 2,
        text: '退款 refund 由 人工客服 support 处理',
      }),
    ]);

    const fullTextBefore = await search.fullTextRecall(
      {
        knowledgeSpaceId: String(space._id),
        sourceIds: [String(sourceId)],
        text: 'refund',
        limit: 10,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(fullTextBefore.length).toBeGreaterThanOrEqual(2);
    expect((await search.resolveModels(String(space._id), false, context)).embedding).toEqual({
      modelId: 'mock-embedding-768',
      dimension: 768,
    });

    const replaced = await bindings.replace(
      String(space._id),
      space.version,
      [
        {
          modelType: 'embedding',
          modelId: 'mock-embedding-1024',
          displayName: 'Mock embedding 1024',
          requiredCapabilities: ['text-embedding', 'dimension:1024'],
          status: 'active',
        },
      ],
      context,
    );
    expect(replaced.version).toBe(2);

    const rebuildRoot = await models.KnowledgeJob.findOne({
      workspaceId,
      knowledgeSpaceId: space._id,
      kind: 'rebuild',
      resourceType: 'space',
      'inputSnapshot.reason': 'model_change',
    }).lean();
    expect(rebuildRoot).toBeTruthy();
    const activeDuringRebuild = await models.KnowledgeModelBinding.findOne({
      workspaceId,
      knowledgeSpaceId: space._id,
      modelType: 'embedding',
      deletedAt: null,
    }).lean();
    expect(activeDuringRebuild).toMatchObject({
      modelId: 'mock-embedding-1024',
      activeQueryModelId: 'mock-embedding-768',
      activeQueryDimension: 768,
    });

    expect(
      await search.fullTextRecall(
        {
          knowledgeSpaceId: String(space._id),
          sourceIds: [String(sourceId)],
          text: 'refund',
          limit: 10,
          options: { timeoutMs: 5_000 },
        },
        context,
      ),
    ).toHaveLength(fullTextBefore.length);
    expect(
      await vectors.recall(
        {
          workspaceId,
          knowledgeSpaceId: String(space._id),
          sourceIds: [String(sourceId)],
          dimension: 768,
          embeddingModelId: 'mock-embedding-768',
          vector: vectorFor(768, 0),
          limit: 10,
        },
        context,
      ),
    ).toHaveLength(3);

    expect(
      await processing.handleQueue(
        'knowledge-rebuild',
        String(rebuildRoot!._id),
        `b14-root-${suffix}`,
        context,
      ),
    ).toBe('succeeded');
    const sourceRebuild = await models.KnowledgeJob.findOne({
      workspaceId,
      kind: 'rebuild',
      resourceType: 'source',
      'inputSnapshot.rootJobId': String(rebuildRoot!._id),
    }).lean();
    expect(sourceRebuild).toBeTruthy();
    expect(
      await processing.handleQueue(
        'knowledge-rebuild',
        String(sourceRebuild!._id),
        `b14-source-${suffix}`,
        context,
      ),
    ).toBe('succeeded');

    const indexChildren = await models.KnowledgeJob.find({
      workspaceId,
      kind: 'index',
      'inputSnapshot.rootJobId': String(rebuildRoot!._id),
    }).lean();
    expect(indexChildren).toHaveLength(3);

    const beforeChildren = await models.KnowledgeSegment.find({
      workspaceId,
      sourceId,
    }).lean();
    expect(
      beforeChildren.every((segment) => segment.indexes.every((index) => index.dimension === 768)),
    ).toBe(true);

    for (const child of indexChildren) {
      expect(
        await processing.handleQueue(
          'knowledge-index',
          String(child._id),
          `b14-index-${suffix}-${String(child._id)}`,
          context,
        ),
      ).toBe('succeeded');
    }

    const activeAfterRebuild = await models.KnowledgeModelBinding.findOne({
      workspaceId,
      knowledgeSpaceId: space._id,
      modelType: 'embedding',
      deletedAt: null,
    }).lean();
    expect(activeAfterRebuild).toMatchObject({
      activeQueryModelId: 'mock-embedding-1024',
      activeQueryDimension: 1024,
    });

    const rebuilt = await models.KnowledgeSegment.find({ workspaceId, sourceId }).lean();
    expect(
      rebuilt.every(
        (segment) =>
          segment.indexes.some(
            (index) =>
              index.indexId === 'default' &&
              index.modelId === 'mock-embedding-1024' &&
              index.dimension === 1024,
          ) && segment.fullTextVersion > 3,
      ),
    ).toBe(true);

    const oldRows = await pool.query(
      'SELECT id FROM knowledge_segment_vectors_768 WHERE workspace_id = $1',
      [workspaceId],
    );
    const newRows = await pool.query(
      'SELECT id FROM knowledge_segment_vectors_1024 WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(oldRows.rows).toHaveLength(3);
    expect(newRows.rows).toHaveLength(3);
    expect(new Set(oldRows.rows.map((row: { id: string }) => row.id))).toEqual(
      new Set(segments.map((segment) => segment.vectorId)),
    );
    expect(
      await vectors.recall(
        {
          workspaceId,
          knowledgeSpaceId: String(space._id),
          sourceIds: [String(sourceId)],
          dimension: 1024,
          embeddingModelId: 'mock-embedding-1024',
          vector: vectorFor(1024, 0),
          limit: 10,
        },
        context,
      ),
    ).toHaveLength(3);

    const target = await models.KnowledgeSegment.findOne({
      workspaceId,
      _id: segments[0]!.segmentId,
    }).lean();
    const upserted = await segmentIndexes.upsert(
      String(target!._id),
      {
        indexId: 'delta',
        type: 'custom',
        text: '退款 refund 差量索引 delta',
        modelId: 'mock-embedding-1024',
        version: target!.version,
      },
      'create',
      context,
    );
    const deltaJob = await models.KnowledgeJob.findOne({
      workspaceId,
      knowledgeSpaceId: space._id,
      kind: 'index',
      resourceId: String(target!._id),
      'inputSnapshot.index.indexId': 'delta',
    }).lean();
    expect(deltaJob).toBeTruthy();
    expect(
      await processing.handleQueue(
        'knowledge-index',
        String(deltaJob!._id),
        `b14-delta-${suffix}`,
        context,
      ),
    ).toBe('succeeded');
    const afterDelta = await models.KnowledgeSegment.find({ workspaceId, sourceId }).lean();
    expect(
      afterDelta.filter((segment) => segment.indexes.some((index) => index.indexId === 'delta')),
    ).toHaveLength(1);
    expect(upserted.indexes.find((index) => index.indexId === 'delta')?.text).toBe(
      '退款 refund 差量索引 delta',
    );
    const deltaRows = await pool.query(
      `SELECT id FROM knowledge_segment_vectors_1024
       WHERE workspace_id = $1 AND segment_id = $2 AND index_id = 'delta'`,
      [workspaceId, String(target!._id)],
    );
    expect(deltaRows.rows).toHaveLength(1);
  }, 90_000);

  it('L1-B14-TRAIN-004-S01 exposes a real MongoDB text index and text query plan', async () => {
    const models = registerKnowledgeModels(connection);
    const space = await seedSpace();
    const sourceId = await seedSource(space._id);
    await seedSegment({
      knowledgeSpaceId: space._id,
      sourceId,
      order: 0,
      text: 'Mongo full text refund policy 全文 索引',
    });

    const indexes = await models.KnowledgeSegment.collection.indexes();
    const fullTextIndex = indexes.find((index) => index.name === 'ix_segment_fulltext');
    expect(fullTextIndex).toMatchObject({
      key: { _fts: 'text', _ftsx: 1 },
      weights: {
        fullTextTokens: 1,
        question: 4,
        answer: 2,
        content: 2,
        'metadata.title': 1,
      },
      default_language: 'none',
    });
    const explanation = await models.KnowledgeSegment.collection
      .find(
        {
          workspaceId,
          knowledgeSpaceId: space._id,
          deletedAt: null,
          searchEnabled: true,
          indexStatus: 'indexed',
          $text: { $search: 'refund' },
        },
        { projection: { score: { $meta: 'textScore' } } },
      )
      .explain('executionStats');
    expect(JSON.stringify(explanation)).toMatch(/TEXT_MATCH|IXSCAN/);
  }, 30_000);

  it('TEST-X-SYNONYM-REBUILD reuses unchanged vectors and only advances full-text/synonym versions', async () => {
    const models = registerKnowledgeModels(connection);
    const space = await seedSpace();
    const sourceId = await seedSource(space._id);
    const seeded = await Promise.all(
      [0, 1, 2].map((order) =>
        seedSegment({
          knowledgeSpaceId: space._id,
          sourceId,
          order,
          text: `synonym source ${order} 退款 到账`,
        }),
      ),
    );
    const segments = await models.KnowledgeSegment.find({ workspaceId, sourceId }).lean();
    const embed = vi.fn(async () => [vectorFor(768, 0)]);
    const adapter = new S09S6RebuildIndexAdapter({
      connection,
      store: new S6ProcessingRepository(connection),
      vectors,
      fulltext,
      processing: { embed },
      models: catalog,
      now: () => new Date('2026-11-18T14:45:00.000Z'),
    });
    const plan = buildRebuildPlan({
      jobId: String(new Types.ObjectId()),
      workspaceId,
      knowledgeSpaceId: String(space._id),
      reason: 'synonym_change',
      candidateFileVersion: 2,
      expectedActiveFileVersion: 1,
      oldPublishedFileVersion: 1,
      sourceIds: [String(sourceId)],
      indexedSegmentVersions: Object.fromEntries(
        segments.map((segment) => [String(segment._id), segment.version]),
      ),
      oldQueryModelId: 'mock-embedding-768',
      oldQueryDimension: 768,
      targetModelId: 'mock-embedding-768',
      targetDimension: 768,
    });

    const staged = await adapter.stage({ plan, context });
    expect(staged).toMatchObject({
      reusedVectorCount: 3,
      rebuiltCount: 0,
      cleanupCandidates: [],
    });
    expect(staged.segments?.map((segment) => segment.index.vectorId).sort()).toEqual(
      seeded.map((segment) => segment.vectorId).sort(),
    );
    expect(staged.segments?.every((segment) => segment.fullTextVersion >= 3)).toBe(true);
    const vectorized = await adapter.reuseOrBuildVector({ plan, staged, context });
    expect(vectorized).toMatchObject({
      reusedVectorCount: 3,
      rebuiltCount: 0,
    });
    expect(embed).not.toHaveBeenCalled();
    const rows = await pool.query(
      'SELECT id FROM knowledge_segment_vectors_768 WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(rows.rows.map((row: { id: string }) => row.id).sort()).toEqual(
      seeded.map((segment) => segment.vectorId).sort(),
    );
  }, 30_000);

  it('TEST-X-PGVECTOR-PARTIAL retries a real partial PostgreSQL write idempotently', async () => {
    const knowledgeSpaceId = String(new Types.ObjectId());
    const sourceId = String(new Types.ObjectId());
    const records = [0, 1].map((order) => ({
      workspaceId,
      knowledgeSpaceId,
      sourceId,
      segmentId: String(new Types.ObjectId()),
      indexId: `partial-${order}`,
      embeddingModelId: 'mock-embedding-768',
      dimension: 768 as const,
      vector: vectorFor(768, order),
      searchEnabled: true,
      contentHash: contentHash(`partial-${order}-${suffix}`),
      version: 1,
    }));
    let calls = 0;
    const failingPool = {
      async query(text: string, values?: unknown[]) {
        calls += 1;
        if (calls === 2) throw new Error('injected pgvector partial failure');
        return pool.query(text, values);
      },
    } as unknown as Pool;
    const failingVectors = new KnowledgeVectorRepository(failingPool);

    await expect(failingVectors.insert(records, context)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' } },
    });
    const partial = await pool.query(
      'SELECT id FROM knowledge_segment_vectors_768 WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(partial.rows).toHaveLength(1);

    const firstAttemptIds = await Promise.all(
      records.map(async (record) => {
        const client = await pool.connect();
        try {
          const expected = await client.query(
            `SELECT id FROM knowledge_segment_vectors_768
             WHERE workspace_id = $1 AND segment_id = $2 AND index_id = $3`,
            [workspaceId, record.segmentId, record.indexId],
          );
          return expected.rows[0]?.id as string | undefined;
        } finally {
          client.release();
        }
      }),
    );
    expect(firstAttemptIds.filter(Boolean)).toHaveLength(1);

    const retried = await vectors.insert(records, context);
    expect(retried.inserted).toBe(2);
    const final = await pool.query<{ id: string }>(
      'SELECT id FROM knowledge_segment_vectors_768 WHERE workspace_id = $1 ORDER BY id',
      [workspaceId],
    );
    expect(final.rows).toHaveLength(2);
    expect(final.rows.map((row) => row.id)).toContain(firstAttemptIds.find(Boolean));
  }, 30_000);
});
