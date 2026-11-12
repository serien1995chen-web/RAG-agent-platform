import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KnowledgeAccessRepository,
  KnowledgeCatalogRepository,
  KnowledgeJobExecutionRepository,
  KnowledgeSegmentIndexRepository,
  S06JobApplication,
} from '../../src/modules/knowledge';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeMongoConnection } from '../../src/shared/runtime/knowledge-connections';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b05_data_${suffix}`;
const foreignWorkspaceId = `ws_b05_data_foreign_${suffix}`;
const memberId = `mem_b05_data_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId,
  requestId: `req_b05_data_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: true,
};
const foreignContext: TenantContext = {
  ...context,
  workspaceId: foreignWorkspaceId,
  memberId: `mem_b05_data_foreign_${suffix}`,
  requestId: `req_b05_data_foreign_${suffix}`,
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let catalog: KnowledgeCatalogRepository;
let jobs: KnowledgeJobExecutionRepository;
let access: KnowledgeAccessRepository;
let s06: S06JobApplication;
let sourceId = '';

function segmentInput(index = 0) {
  return {
    question: `B05 manual question ${index} 中文`,
    answer: `B05 manual answer ${index} 🙌`,
    searchEnabled: true,
    metadata: { testId: `L1-B05-DATA-004-${index}` },
  };
}

function batchItems(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    sourceId,
    ...segmentInput(start + index),
  }));
}

async function seedSource() {
  const models = registerKnowledgeModels(connection);
  const spaceObjectId = new connection.base.Types.ObjectId();
  const sourceObjectId = new connection.base.Types.ObjectId();
  sourceId = String(sourceObjectId);
  await models.KnowledgeSpace.create({
    _id: spaceObjectId,
    workspaceId,
    knowledgeSpaceId: null,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    kind: 'space',
    parentSpaceId: null,
    name: `B05 Data space ${suffix}`,
    normalizedName: `b05-data-${suffix}`,
    description: '',
    iconKey: 'book-open',
    ownershipMemberId: memberId,
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
    referenceRevision: 0,
    permissionRevision: 1,
    modelBindings: {},
    defaultChunking: {},
    status: 'active',
  });
  await models.KnowledgeSource.create({
    _id: sourceObjectId,
    workspaceId,
    knowledgeSpaceId: spaceObjectId,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    directoryId: null,
    kind: 'text',
    name: `B05 Data source ${suffix}`,
    externalId: null,
    connectorId: null,
    blobRefId: new connection.base.Types.ObjectId(),
    originalUrl: null,
    mimeType: 'text/plain; charset=utf-8',
    sizeBytes: 256,
    contentHash: `b05-data-${suffix}`,
    parseProvider: 'liteparse',
    processingStatus: 'ready',
    sourceVersion: 1,
    searchEnabled: true,
    permissionState: 'disabled',
    permissionRevision: 0,
    ownershipMemberId: memberId,
    metadata: { batch: 'B05' },
    tagValues: [],
  });
}

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  jobs = new KnowledgeJobExecutionRepository(connection);
  access = new KnowledgeAccessRepository(connection);
  const segmentIndexes = new KnowledgeSegmentIndexRepository(connection, jobs, {
    async listModels() {
      return [
        {
          modelId: 'mock-embedding-1024',
          displayName: 'Mock embedding 1024',
          type: 'embedding' as const,
          capabilities: ['text-embedding', 'dimension:1024'],
          dimension: 1024,
          authorized: true,
        },
      ];
    },
  });
  s06 = new S06JobApplication(jobs, segmentIndexes, catalog, access);
}, 60_000);

beforeEach(async () => {
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({
      workspaceId: { $in: [workspaceId, foreignWorkspaceId] },
    });
  }
  await seedSource();
});

afterAll(async () => {
  if (!connection) return;
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({
      workspaceId: { $in: [workspaceId, foreignWorkspaceId] },
    });
  }
  await connection.close();
});

describe('B05 DATA-004 direct Segment creation and batch processing', () => {
  it('L1-B05-DATA-004-P01 creates chunk and QA items, lists them, and reaches a searchable index', async () => {
    const chunk = await catalog.createSegment(sourceId, segmentInput(1), context);
    const qa = await catalog.createSegment(
      sourceId,
      { ...segmentInput(2), metadata: { mode: 'qa' } },
      context,
    );
    const list = await catalog.listSegments(sourceId, { limit: 20, sort: 'order' }, context);
    expect(list.items.map((item) => item.id)).toEqual([chunk.id, qa.id]);
    expect(list.items.map((item) => item.indexStatus)).toEqual(['pending', 'pending']);

    const models = registerKnowledgeModels(connection);
    const indexJobs = await models.KnowledgeJob.find({
      workspaceId,
      resourceType: 'segment',
      resourceId: { $in: [chunk.id, qa.id] },
    }).lean();
    expect(
      indexJobs.length,
      'each asynchronous Segment create must own a traceable index Job',
    ).toBe(2);
    expect(
      await models.KnowledgeSegment.countDocuments({
        workspaceId,
        _id: { $in: [chunk.id, qa.id] },
        'indexes.vectorId': { $exists: true, $ne: null },
      }),
    ).toBe(2);
  });

  it('L1-B05-DATA-004-N01 rejects empty QA answers with a stable item validation code', async () => {
    const emptyAnswer = await s06
      .dispatch({
        operationId: 'API-SEGMENT-BATCH',
        params: {},
        query: {},
        headers: {},
        body: {
          action: 'upsert',
          items: [{ sourceId, question: '问题', answer: '' }],
        },
        context,
      })
      .catch((error) => error);
    expect(emptyAnswer).toMatchObject({
      status: 207,
      data: {
        failed: 1,
        items: [{ success: false, code: 'KNOWLEDGE_VALIDATION_FAILED' }],
      },
    });
    const models = registerKnowledgeModels(connection);
    expect(await models.KnowledgeSegment.countDocuments({ workspaceId })).toBe(0);
  });

  it('L1-B05-DATA-004-N03 rejects unknown item fields before persistence', async () => {
    const unknownField = await s06
      .dispatch({
        operationId: 'API-SEGMENT-BATCH',
        params: {},
        query: {},
        headers: {},
        body: {
          action: 'upsert',
          items: [{ sourceId, ...segmentInput(3), unknownField: true }],
        },
        context,
      })
      .catch((error) => error);
    expect(unknownField).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    const models = registerKnowledgeModels(connection);
    expect(await models.KnowledgeSegment.countDocuments({ workspaceId })).toBe(0);
  });

  it('L1-B05-DATA-004-N04 rejects invalid custom index/model input before persistence', async () => {
    const invalidIndex = await s06
      .dispatch({
        operationId: 'API-SEGMENT-BATCH',
        params: {},
        query: {},
        headers: {},
        body: {
          action: 'upsert',
          items: [
            {
              sourceId,
              ...segmentInput(4),
              indexes: [
                {
                  indexId: 'bad index id',
                  type: 'custom',
                  text: 'bad',
                  modelId: 'missing-model',
                  dimension: 1024,
                },
              ],
            },
          ],
        },
        context,
      })
      .catch((error) => error);
    expect(invalidIndex).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    const models = registerKnowledgeModels(connection);
    expect(await models.KnowledgeSegment.countDocuments({ workspaceId })).toBe(0);
  });

  it('L1-B05-DATA-004-N02/Q01 accepts 200 batch items and rejects 201', async () => {
    await expect(
      s06.dispatch({
        operationId: 'API-SEGMENT-BATCH',
        params: {},
        query: {},
        headers: {},
        body: { action: 'upsert', items: batchItems(0, 201) },
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });

    const result = await s06.dispatch({
      operationId: 'API-SEGMENT-BATCH',
      params: {},
      query: {},
      headers: {},
      body: { action: 'upsert', items: batchItems(0, 200) },
      context,
    });
    expect(result).toMatchObject({
      status: 200,
      data: { requested: 200, succeeded: 200, failed: 0 },
    });
    const models = registerKnowledgeModels(connection);
    expect(
      await models.KnowledgeJob.countDocuments({
        workspaceId,
        kind: { $in: ['index', 'segment'] },
      }),
      'a 200-item batch must expose one traceable batch Job or per-item index Jobs',
    ).toBe(200);
  }, 30_000);

  it('L1-B05-DATA-004-A01 rejects a mixed cross-tenant batch before any legal item is written', async () => {
    const batch = await s06
      .dispatch({
        operationId: 'API-SEGMENT-BATCH',
        params: {},
        query: {},
        headers: {},
        body: {
          action: 'upsert',
          items: [segmentInput(1), segmentInput(2)].map((item) => ({ sourceId, ...item })),
        },
        context: foreignContext,
      })
      .catch((error) => error);
    expect(batch).toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });

    const models = registerKnowledgeModels(connection);
    expect(await models.KnowledgeSegment.countDocuments({ workspaceId })).toBe(0);
    expect(await models.KnowledgeSegment.countDocuments({ workspaceId: foreignWorkspaceId })).toBe(
      0,
    );

    await expect(
      catalog.createSegment(sourceId, segmentInput(5), {
        ...context,
        workspaceId: '',
        requestId: 'req_b05_missing_tenant',
      } as TenantContext),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });

  it('L1-B05-DATA-004-C01/F01 retries only failed batch items without duplicating successful items', async () => {
    const existing = await catalog.createSegment(sourceId, segmentInput(10), context);
    const first = await s06.dispatch({
      operationId: 'API-SEGMENT-BATCH',
      params: {},
      query: {},
      headers: {},
      body: {
        action: 'upsert',
        items: [
          { sourceId, ...segmentInput(11) },
          {
            id: existing.id,
            version: existing.version + 100,
            question: 'stale write',
            answer: 'stale',
          },
        ],
      },
      context,
    });
    expect(first).toMatchObject({ status: 207, data: { requested: 2, succeeded: 1, failed: 1 } });
    const successful = (
      first.data as { items: Array<{ id: string; success: boolean }> }
    ).items.find((item) => item.success);
    expect(successful?.id).toBeTruthy();

    const retry = await s06.dispatch({
      operationId: 'API-SEGMENT-BATCH',
      params: {},
      query: {},
      headers: {},
      body: {
        action: 'upsert',
        items: [
          {
            id: existing.id,
            version: existing.version,
            question: 'retry succeeds once',
            answer: 'retry answer',
          },
        ],
      },
      context,
    });
    expect(retry).toMatchObject({ status: 200, data: { requested: 1, succeeded: 1, failed: 0 } });
    expect(await catalog.getSegment(successful!.id, context)).toMatchObject({
      id: successful!.id,
      version: 1,
    });
    expect(await catalog.getSegment(existing.id, context)).toMatchObject({
      question: 'retry succeeds once',
      version: 2,
    });
  });

  it('L1-B05-DATA-004-S01 records Segment, Job, Outbox, audit, and final index evidence', async () => {
    const created = await catalog.createSegment(sourceId, segmentInput(20), context);
    const models = registerKnowledgeModels(connection);
    const job = await models.KnowledgeJob.findOne({
      workspaceId,
      resourceType: 'segment',
      resourceId: created.id,
    }).lean();
    expect(job).toMatchObject({
      kind: 'index',
      status: expect.stringMatching(/queued|leased|running|succeeded/),
      inputSnapshot: { segmentVersion: created.version },
    });
    expect(
      await models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateType: 'job',
        aggregateId: job?.jobId ?? job?._id?.toString(),
      }),
    ).toBe(1);
    expect(
      await models.KnowledgeAuditEvent.countDocuments({
        workspaceId,
        resourceType: 'segment',
        resourceId: created.id,
        action: 'segment.create',
      }),
    ).toBe(1);
    expect(created).toMatchObject({
      id: expect.any(String),
      question: segmentInput(20).question,
      answer: segmentInput(20).answer,
      indexStatus: 'pending',
    });
  });
});
