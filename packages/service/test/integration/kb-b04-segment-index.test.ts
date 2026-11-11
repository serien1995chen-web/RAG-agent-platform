import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Candidate } from '@kb/search';
import { S7SearchAuthorizationAdapter } from '../../src/modules/knowledge/adapter/s7-search-authorization.adapter';
import {
  KnowledgeCatalogRepository,
  KnowledgeJobExecutionRepository,
  KnowledgeAccessRepository,
  KnowledgeSegmentIndexRepository,
} from '../../src/modules/knowledge';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { KnowledgeSegmentDoc } from '../../src/shared/persistence/schemas/knowledge-catalog.schemas';
import { createKnowledgeMongoConnection } from '../../src/shared/runtime/knowledge-connections';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b04_integration_${suffix}`;
const knowledgeSpaceId = new mongoose.Types.ObjectId();
const sourceId = new mongoose.Types.ObjectId();
const context: TenantContext = {
  workspaceId,
  memberId: `mem_b04_${suffix}`,
  requestId: `req_b04_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: true,
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let catalog: KnowledgeCatalogRepository;
let jobs: KnowledgeJobExecutionRepository;
let segmentIndexes: KnowledgeSegmentIndexRepository;

const modelCatalog = {
  async listModels() {
    return ([768, 1024, 1536, 3072] as const).map((dimension) => ({
      modelId: `mock-embedding-${dimension}`,
      displayName: `Mock embedding ${dimension}`,
      type: 'embedding' as const,
      capabilities: ['text-embedding', `dimension:${dimension}`],
      dimension,
      authorized: true,
    }));
  },
};

function indexValue(input: {
  indexId: string;
  type: 'default' | 'custom';
  dimension: 768 | 1024 | 1536 | 3072;
  version: number;
  text?: string;
}) {
  return {
    indexId: input.indexId,
    type: input.type,
    modelId: `mock-embedding-${input.dimension}`,
    dimension: input.dimension,
    storageType: input.dimension === 3072 ? ('halfvec' as const) : ('vector' as const),
    vectorProfile: `knowledge_segment_vectors_${input.dimension}`,
    vectorId: randomUUID(),
    text: input.text ?? `${input.indexId} index text`,
    version: input.version,
  };
}

async function seedSegment(input: {
  order: number;
  question: string;
  answer?: string;
  searchEnabled?: boolean;
  indexStatus?: KnowledgeSegmentDoc['indexStatus'];
  indexErrorCode?: string | null;
  indexes?: KnowledgeSegmentDoc['indexes'];
  history?: Array<Record<string, unknown>>;
}) {
  const models = registerKnowledgeModels(connection);
  const segmentId = new mongoose.Types.ObjectId();
  const answer = input.answer ?? `${input.question} answer`;
  await models.KnowledgeSegment.create({
    _id: segmentId,
    workspaceId,
    knowledgeSpaceId,
    version: 3,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    sourceId,
    sourceVersion: 1,
    searchEnabled: input.searchEnabled ?? true,
    order: input.order,
    question: input.question,
    answer,
    content: `${input.question}\n${answer}`,
    fullTextTokens: input.question,
    fullTextVersion: 3,
    metadata: { section: 'b04', order: input.order },
    history: input.history ?? [],
    indexes: input.indexes ?? [],
    indexStatus: input.indexStatus ?? 'indexed',
    indexErrorCode: input.indexErrorCode ?? null,
    imageBlobRefId: null,
    imageDescription: null,
    synonymVersion: 0,
  });
  return String(segmentId);
}

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  jobs = new KnowledgeJobExecutionRepository(connection);
  segmentIndexes = new KnowledgeSegmentIndexRepository(connection, jobs, modelCatalog);
}, 60_000);

beforeEach(async () => {
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({ workspaceId });
  }
  const models = registerKnowledgeModels(connection);
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
    name: `B04 integration source ${suffix}`,
    externalId: null,
    connectorId: null,
    blobRefId: new mongoose.Types.ObjectId(),
    originalUrl: null,
    mimeType: 'text/plain',
    sizeBytes: 128,
    contentHash: `b04-${suffix}`,
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
});

afterAll(async () => {
  if (!connection) return;
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('B04 Segment CRUD, indexes and status', () => {
  it('L1-B04-DATA-001-P01 Segment create list detail update and metadata persist by stable ID', async () => {
    const first = await catalog.createSegment(
      String(sourceId),
      {
        question: '退款多久到账？',
        answer: '通常五个工作日内到账。',
        searchEnabled: true,
        metadata: { locale: 'zh-CN' },
      },
      context,
    );
    const second = await catalog.createSegment(
      String(sourceId),
      {
        question: '如何联系人工客服？',
        answer: '工作时间可联系人工客服。',
        searchEnabled: true,
        metadata: {},
      },
      context,
    );
    const third = await catalog.createSegment(
      String(sourceId),
      {
        question: '如何修改地址？',
        answer: '在账户设置中修改。',
        searchEnabled: true,
        metadata: {},
      },
      context,
    );

    const list = await catalog.listSegments(
      String(sourceId),
      { limit: 20, sort: 'order' },
      context,
    );
    expect(list.items.map((item) => item.id)).toEqual([first.id, second.id, third.id]);
    expect(list.items[0]).toMatchObject({
      id: first.id,
      order: 0,
      question: '退款多久到账？',
      answer: '通常五个工作日内到账。',
      metadata: { locale: 'zh-CN' },
    });

    const updated = await catalog.updateSegment(
      first.id,
      {
        question: '退款多久到账？更新',
        answer: '通常三个工作日内到账。',
        metadata: { locale: 'zh-CN', reviewed: true },
        searchEnabled: false,
        version: first.version,
      },
      context,
    );
    expect(updated).toMatchObject({
      id: first.id,
      question: '退款多久到账？更新',
      answer: '通常三个工作日内到账。',
      metadata: { locale: 'zh-CN', reviewed: true },
      searchEnabled: false,
      version: first.version + 1,
    });
    expect(await catalog.getSegment(first.id, context)).toMatchObject({
      id: first.id,
      version: updated.version,
      searchEnabled: false,
    });
  });

  it('L1-B04-DATA-001-N01 stale Segment version is rejected without partial metadata update', async () => {
    const segmentId = await seedSegment({ order: 1, question: 'old version target' });
    await expect(
      catalog.updateSegment(
        segmentId,
        {
          question: 'stale overwrite',
          metadata: { stale: true },
          version: 1,
        },
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
    expect(await catalog.getSegment(segmentId, context)).toMatchObject({
      question: 'old version target',
      version: 3,
      metadata: { section: 'b04', order: 1 },
    });
  });

  it('L1-B04-DATA-001-S01 update and delete affect only the target Segment and enqueue one delete', async () => {
    const first = await seedSegment({
      order: 0,
      question: 'delete only me',
      indexes: [indexValue({ indexId: 'default', type: 'default', dimension: 1024, version: 3 })],
    });
    const second = await seedSegment({
      order: 1,
      question: 'update only me',
      indexes: [indexValue({ indexId: 'default', type: 'default', dimension: 1536, version: 3 })],
    });
    const third = await seedSegment({
      order: 2,
      question: 'leave me unchanged',
      indexes: [indexValue({ indexId: 'default', type: 'default', dimension: 3072, version: 3 })],
    });
    const beforeThird = await catalog.getSegment(third, context);

    await catalog.updateSegment(
      second,
      { question: 'updated safely', answer: 'sibling isolation', version: 3 },
      context,
    );
    const deleted = await catalog.deleteSegment(first, context, 3);
    expect(deleted).toMatchObject({ id: first, status: 'accepted' });
    expect((await catalog.getSegment(second, context)).question).toBe('updated safely');
    expect(await catalog.getSegment(third, context)).toEqual(beforeThird);

    const list = await catalog.listSegments(
      String(sourceId),
      { limit: 20, sort: 'order' },
      context,
    );
    expect(list.items.map((item) => item.id)).toEqual([second, third]);
    const models = registerKnowledgeModels(connection);
    expect(
      await models.KnowledgeJob.countDocuments({
        workspaceId,
        resourceId: first,
        kind: 'delete',
      }),
    ).toBe(1);
    expect(
      await models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateId: first,
        eventType: 'delete',
      }),
    ).toBe(1);
  });

  it('L1-B04-DATA-001-C01 two Segment updates at one version allow exactly one writer', async () => {
    const segmentId = await seedSegment({ order: 0, question: 'concurrent target' });
    const results = await Promise.allSettled([
      catalog.updateSegment(
        segmentId,
        { question: 'writer A', answer: 'A', version: 3 },
        { ...context, requestId: `req_b04_a_${suffix}` },
      ),
      catalog.updateSegment(
        segmentId,
        { question: 'writer B', answer: 'B', version: 3 },
        { ...context, requestId: `req_b04_b_${suffix}` },
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await catalog.getSegment(segmentId, context)).version).toBe(4);
  });

  it('L1-B04-DATA-001-F01 failed index state preserves latest content and safe failure reason', async () => {
    const segmentId = await seedSegment({
      order: 0,
      question: 'content survives failure',
      indexStatus: 'error',
      indexErrorCode: 'KNOWLEDGE_MODEL_FAILED',
      indexes: [indexValue({ indexId: 'default', type: 'default', dimension: 768, version: 3 })],
    });
    const segment = await catalog.getSegment(segmentId, context);
    expect(segment).toMatchObject({
      question: 'content survives failure',
      indexStatus: 'error',
      indexErrorCode: 'KNOWLEDGE_MODEL_FAILED',
      version: 3,
    });
    expect(segment.indexes).toHaveLength(1);
  });

  it('L1-B04-DATA-002-P01 custom index create update delete persists final index value', async () => {
    const segmentId = await seedSegment({
      order: 0,
      question: 'custom index target',
      indexes: [indexValue({ indexId: 'default', type: 'default', dimension: 768, version: 3 })],
    });
    const created = await segmentIndexes.upsert(
      segmentId,
      {
        indexId: 'custom_refund',
        type: 'custom',
        text: '退款规则自定义索引',
        modelId: 'mock-embedding-1024',
        version: 3,
      },
      'create',
      context,
    );
    const custom = created.indexes.find((index) => index.indexId === 'custom_refund');
    expect(custom).toMatchObject({
      type: 'custom',
      dimension: 1024,
      storageType: 'vector',
      vectorProfile: 'knowledge_segment_vectors_1024',
      text: '退款规则自定义索引',
    });
    const updated = await segmentIndexes.upsert(
      segmentId,
      {
        indexId: 'custom_refund',
        type: 'custom',
        text: '退款规则最终索引',
        modelId: 'mock-embedding-3072',
        version: created.version,
      },
      'update',
      context,
    );
    expect(updated.indexes.find((index) => index.indexId === 'custom_refund')).toMatchObject({
      dimension: 3072,
      storageType: 'halfvec',
      vectorProfile: 'knowledge_segment_vectors_3072',
      text: '退款规则最终索引',
    });
    const removed = await segmentIndexes.remove(
      segmentId,
      'custom_refund',
      updated.version,
      context,
    );
    expect(removed).toMatchObject({ id: segmentId, status: 'accepted' });
    expect((await segmentIndexes.history(segmentId, context)).items.length).toBeGreaterThan(0);
  });

  it('L1-B04-DATA-002-N01 system default index cannot be updated through the index API', async () => {
    const segmentId = await seedSegment({
      order: 0,
      question: 'system index target',
      indexes: [indexValue({ indexId: 'default', type: 'default', dimension: 1024, version: 3 })],
    });
    await expect(
      segmentIndexes.upsert(
        segmentId,
        {
          indexId: 'default',
          type: 'custom',
          text: 'attempt to overwrite generated system index',
          modelId: 'mock-embedding-1024',
          version: 3,
        },
        'update',
        context,
      ),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: expect.stringMatching(/KNOWLEDGE_(VALIDATION_FAILED|FORBIDDEN|CONFLICT)/),
        },
      },
    });
    expect((await catalog.getSegment(segmentId, context)).version).toBe(3);
  });

  it('L1-B04-DATA-002-S01 index history records the previous question answer and index values', async () => {
    const segmentId = await seedSegment({
      order: 0,
      question: 'history question v3',
      answer: 'history answer v3',
      indexes: [indexValue({ indexId: 'default', type: 'default', dimension: 768, version: 3 })],
      history: [
        {
          version: 2,
          question: 'history question v2',
          answer: 'history answer v2',
          changedAt: new Date('2026-11-11T00:00:00.000Z'),
          changedByMemberId: context.memberId,
        },
      ],
    });
    await segmentIndexes.upsert(
      segmentId,
      {
        indexId: 'custom_history',
        type: 'custom',
        text: 'history custom index v4',
        modelId: 'mock-embedding-1536',
        version: 3,
      },
      'create',
      context,
    );
    const history = await segmentIndexes.history(segmentId, context);
    expect(
      history.items.some(
        (entry) =>
          entry.version === 3 &&
          Array.isArray(entry.indexes) &&
          entry.indexes.some((index: Record<string, unknown>) => index.indexId === 'default'),
      ),
    ).toBe(true);
  });

  it('L1-B04-DATA-002-C01 concurrent create of one custom index produces one active value', async () => {
    const segmentId = await seedSegment({
      order: 0,
      question: 'concurrent custom index',
      indexes: [indexValue({ indexId: 'default', type: 'default', dimension: 768, version: 3 })],
    });
    const results = await Promise.allSettled([
      segmentIndexes.upsert(
        segmentId,
        {
          indexId: 'custom_race',
          type: 'custom',
          text: 'race A',
          modelId: 'mock-embedding-768',
          version: 3,
        },
        'create',
        { ...context, requestId: `req_b04_custom_a_${suffix}` },
      ),
      segmentIndexes.upsert(
        segmentId,
        {
          indexId: 'custom_race',
          type: 'custom',
          text: 'race B',
          modelId: 'mock-embedding-768',
          version: 3,
        },
        'create',
        { ...context, requestId: `req_b04_custom_b_${suffix}` },
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const segment = await catalog.getSegment(segmentId, context);
    expect(segment.indexes.filter((index) => index.indexId === 'custom_race')).toHaveLength(1);
  });

  it('L1-B04-DATA-002-F01 invalid model failure leaves indexes and Jobs unchanged', async () => {
    const segmentId = await seedSegment({
      order: 0,
      question: 'failed index target',
      indexes: [indexValue({ indexId: 'default', type: 'default', dimension: 768, version: 3 })],
    });
    const before = await catalog.getSegment(segmentId, context);
    const models = registerKnowledgeModels(connection);
    const jobCount = await models.KnowledgeJob.countDocuments({ workspaceId });
    await expect(
      segmentIndexes.upsert(
        segmentId,
        {
          indexId: 'custom_invalid_model',
          type: 'custom',
          text: 'must not persist',
          modelId: 'unauthorized-model',
          version: 3,
        },
        'create',
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } } });
    expect(await catalog.getSegment(segmentId, context)).toEqual(before);
    expect(await models.KnowledgeJob.countDocuments({ workspaceId })).toBe(jobCount);
  });

  it('L1-B04-DATA-002-N03 invalid index ID and empty text fail before persistence', async () => {
    const segmentId = await seedSegment({ order: 0, question: 'invalid index target' });
    await expect(
      segmentIndexes.upsert(
        segmentId,
        {
          indexId: 'contains spaces',
          type: 'custom',
          text: 'valid text',
          modelId: 'mock-embedding-768',
          version: 3,
        },
        'create',
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } } });
    await expect(
      segmentIndexes.upsert(
        segmentId,
        {
          indexId: 'custom_empty',
          type: 'custom',
          text: '   ',
          modelId: 'mock-embedding-768',
          version: 3,
        },
        'create',
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } } });
    expect(await catalog.getSegment(segmentId, context)).toMatchObject({
      version: 3,
      indexes: [],
    });
  });

  it('L1-B04-DATA-003-N03 malformed Job ID fails closed without BSON internals', async () => {
    await expect(jobs.getRaw('not-a-job-id', context)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });

  it('L1-B04-DATA-001-S02 Segment and parent Source search switches reject semantic and full-text candidates', async () => {
    const models = registerKnowledgeModels(connection);
    const searchSpaceId = new mongoose.Types.ObjectId();
    await models.KnowledgeSpace.create({
      _id: searchSpaceId,
      workspaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      knowledgeSpaceId: null,
      kind: 'space',
      parentSpaceId: null,
      name: `B04 search switch ${suffix}`,
      normalizedName: `b04-search-switch-${suffix}`,
      description: '',
      iconKey: 'search',
      ownershipMemberId: context.memberId,
      accessMode: 'workspace',
      sourceAclMode: 'inherited',
      sourcePermissionEnabled: true,
      referenceRevision: 0,
      permissionRevision: 1,
      modelBindings: {},
      defaultChunking: {},
      status: 'active',
    });
    await models.KnowledgeSource.updateOne(
      { workspaceId, _id: sourceId },
      { $set: { knowledgeSpaceId: searchSpaceId, sourceVersion: 1 } },
    );
    await models.KnowledgeResourcePermission.create({
      workspaceId,
      knowledgeSpaceId: searchSpaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      resourceType: 'space',
      resourceId: searchSpaceId,
      principalType: 'member',
      principalId: context.memberId,
      permission: 'read',
      inheritMode: 'override',
      snapshotVersion: 1,
    });
    const searchSegmentId = await seedSegment({
      order: 3,
      question: 'retrievable only while switches are enabled',
      indexes: [indexValue({ indexId: 'default', type: 'default', dimension: 768, version: 3 })],
    });
    await models.KnowledgeSegment.updateOne(
      { workspaceId, _id: searchSegmentId },
      { $set: { knowledgeSpaceId: searchSpaceId } },
    );
    const authorization = new S7SearchAuthorizationAdapter(
      connection,
      new KnowledgeAccessRepository(connection),
    );
    const candidate: Candidate = {
      docId: `${String(searchSpaceId)}:${searchSegmentId}`,
      segmentId: searchSegmentId,
      sourceId: String(sourceId),
      knowledgeSpaceId: String(searchSpaceId),
      score: 0.9,
      embeddingScore: 0.9,
      scores: [{ type: 'embedding', value: 0.9, index: 0 }],
      text: '',
      indexId: 'default',
      indexVersion: 3,
    };
    const searchContext = {
      ...context,
      scopes: ['knowledge:search', 'knowledge:read'],
    };

    expect((await authorization.hydrate([candidate], searchContext)).items).toHaveLength(1);
    await models.KnowledgeSegment.updateOne(
      { workspaceId, _id: searchSegmentId },
      { $set: { searchEnabled: false }, $inc: { version: 1 } },
    );
    expect((await authorization.hydrate([candidate], searchContext)).items).toHaveLength(0);
    await models.KnowledgeSegment.updateOne(
      { workspaceId, _id: searchSegmentId },
      { $set: { searchEnabled: true }, $inc: { version: 1 } },
    );
    await models.KnowledgeSource.updateOne(
      { workspaceId, _id: sourceId },
      { $set: { searchEnabled: false }, $inc: { version: 1 } },
    );
    expect((await authorization.hydrate([candidate], searchContext)).items).toHaveLength(0);
    await models.KnowledgeSource.updateOne(
      { workspaceId, _id: sourceId },
      { $set: { searchEnabled: true }, $inc: { version: 1 } },
    );
    expect((await authorization.hydrate([candidate], searchContext)).items).toHaveLength(1);
  });

  it('L1-B04-DATA-003-P01 list and detail expose final index status and safe failure reason', async () => {
    const indexed = await seedSegment({
      order: 0,
      question: 'indexed segment',
      indexStatus: 'indexed',
    });
    const failed = await seedSegment({
      order: 1,
      question: 'failed segment',
      indexStatus: 'rebuild_failed',
      indexErrorCode: 'KNOWLEDGE_MODEL_FAILED',
    });
    const listed = await catalog.listSegments(
      String(sourceId),
      { limit: 20, sort: 'order' },
      context,
    );
    expect(listed.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: indexed, indexStatus: 'indexed' }),
        expect.objectContaining({
          id: failed,
          indexStatus: 'rebuild_failed',
          indexErrorCode: 'KNOWLEDGE_MODEL_FAILED',
        }),
      ]),
    );
    expect(await catalog.getSegment(failed, context)).toMatchObject({
      indexStatus: 'rebuild_failed',
      indexErrorCode: 'KNOWLEDGE_MODEL_FAILED',
    });
  });

  it('L1-B04-DATA-003-N01 invalid persisted status is rejected instead of mapped to success', async () => {
    const models = registerKnowledgeModels(connection);
    await expect(
      models.KnowledgeSegment.create({
        workspaceId,
        knowledgeSpaceId,
        version: 1,
        deletedAt: null,
        createdByMemberId: context.memberId,
        updatedByMemberId: context.memberId,
        sourceId,
        sourceVersion: 1,
        searchEnabled: true,
        order: 99,
        question: 'invalid status',
        answer: 'invalid status',
        content: 'invalid status',
        fullTextTokens: '',
        fullTextVersion: 0,
        metadata: {},
        history: [],
        indexes: [],
        indexStatus: 'success',
        indexErrorCode: null,
        imageBlobRefId: null,
        imageDescription: null,
        synonymVersion: 0,
      }),
    ).rejects.toThrow(/indexStatus/);
    expect(await models.KnowledgeSegment.countDocuments({ workspaceId, order: 99 })).toBe(0);
  });

  it('L1-B04-DATA-003-S01 status query is read-only and retains successful indexes after failure', async () => {
    const defaultIndex = indexValue({
      indexId: 'default',
      type: 'default',
      dimension: 768,
      version: 3,
    });
    const segmentId = await seedSegment({
      order: 0,
      question: 'last successful index',
      indexStatus: 'rebuild_failed',
      indexErrorCode: 'KNOWLEDGE_MODEL_FAILED',
      indexes: [defaultIndex],
    });
    const before = await catalog.getSegment(segmentId, context);
    const listed = await catalog.listSegments(
      String(sourceId),
      { limit: 20, sort: 'order' },
      context,
    );
    const after = await catalog.getSegment(segmentId, context);
    expect(listed.items).toHaveLength(1);
    expect(after).toEqual(before);
    expect(after.indexes[0]).toMatchObject({
      indexId: 'default',
      vectorId: defaultIndex.vectorId,
    });
  });

  it('L1-B04-DATA-003-F02 missing Job query fails safely without deleting Segment history or indexes', async () => {
    const segmentId = await seedSegment({
      order: 0,
      question: 'missing job target',
      indexes: [indexValue({ indexId: 'default', type: 'default', dimension: 768, version: 3 })],
      history: [
        {
          version: 2,
          question: 'prior',
          answer: 'prior',
          changedAt: new Date('2026-11-11T00:00:00.000Z'),
          changedByMemberId: context.memberId,
        },
      ],
    });
    const before = await catalog.getSegment(segmentId, context);
    await expect(
      jobs.getRaw(new mongoose.Types.ObjectId().toString(), context),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    expect(await catalog.getSegment(segmentId, context)).toEqual(before);
    expect((await segmentIndexes.history(segmentId, context)).items).toHaveLength(1);
  });
});
