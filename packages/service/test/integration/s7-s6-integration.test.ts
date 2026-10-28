import { randomUUID } from 'node:crypto';
import mongoose, { type Types } from 'mongoose';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CitationApi } from '@kb/contracts';
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
import { S06ProcessingApplication } from '../../src/modules/knowledge/application/s06-processing.application';
import { S5ProcessingApplication } from '../../src/modules/knowledge/application/s5-processing.application';
import { KnowledgeFullTextRepository } from '../../src/modules/knowledge/repository/fulltext.repository';
import { KnowledgeJobExecutionRepository } from '../../src/modules/knowledge/repository/job-execution.repository';
import { S6ProcessingRepository } from '../../src/modules/knowledge/repository/s06-processing.repository';
import { KnowledgeSegmentIndexRepository } from '../../src/modules/knowledge/repository/segment-index.repository';
import { S5MockModelCatalog } from '../../src/modules/knowledge/adapter/s5-aiproxy-catalog.adapter';
import { S7SearchAuthorizationAdapter } from '../../src/modules/knowledge/adapter/s7-search-authorization.adapter';
import { S7SearchPipelineFactory } from '../../src/modules/knowledge/adapter/s7-search-pipeline.factory';
import { KnowledgeAccessRepository } from '../../src/modules/knowledge/repository/access.repository';
import { S7FilterSourceRepository } from '../../src/modules/knowledge/repository/s7-filter-source.repository';
import { S7SearchRepository } from '../../src/modules/knowledge/repository/s7-search.repository';
import { S7SearchApplication } from '../../src/modules/knowledge/application/s7-search.application';
import type {
  S5GatewayResult,
  S5ModelGatewayPort,
} from '../../src/modules/knowledge/application/s5-model-gateway.port';
import type { Candidate } from '@kb/search';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s7_s6_${suffix}`;
const memberId = `mem_s7_s6_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId,
  requestId: `req-s7-s6-${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:search', 'knowledge:write'],
};

let connection: mongoose.Connection;
let pool: Pool;
let spaceId: Types.ObjectId;
let sourceId: Types.ObjectId;
let segmentId: Types.ObjectId;
let s7Search: S7SearchRepository;
let vectors: KnowledgeVectorRepository;
let authorization: S7SearchAuthorizationAdapter;

async function seed() {
  const models = registerKnowledgeModels(connection);
  const space = await models.KnowledgeSpace.create({
    workspaceId,
    knowledgeSpaceId: null,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    kind: 'space',
    parentSpaceId: null,
    name: `S7 S6 ${suffix}`,
    normalizedName: `s7-s6-${suffix}`,
    description: '',
    iconKey: 'search',
    ownershipMemberId: memberId,
    accessMode: 'workspace',
    sourceAclMode: 'enforced',
    sourcePermissionEnabled: true,
    referenceRevision: 0,
    permissionRevision: 1,
    modelBindings: {},
    defaultChunking: {},
    status: 'active',
  });
  spaceId = space._id;
  const source = await models.KnowledgeSource.create({
    workspaceId,
    knowledgeSpaceId: spaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    directoryId: null,
    kind: 'text',
    name: 'Refund policy',
    externalId: null,
    connectorId: null,
    blobRefId: null,
    originalUrl: 'https://example.invalid/refund',
    mimeType: 'text/plain',
    sizeBytes: 48,
    contentHash: `source-${suffix}`,
    parseProvider: 'liteparse',
    processingStatus: 'ready',
    sourceVersion: 1,
    searchEnabled: true,
    permissionState: 'disabled',
    permissionRevision: 1,
    ownershipMemberId: memberId,
    metadata: {},
    tagValues: [],
  });
  sourceId = source._id;
  const segment = await models.KnowledgeSegment.create({
    workspaceId,
    knowledgeSpaceId: spaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    sourceId,
    sourceVersion: 1,
    searchEnabled: true,
    order: 0,
    question: 'How long does a refund take?',
    answer: 'Refunds take five business days.',
    content: 'Refunds take five business days.',
    fullTextTokens: '',
    fullTextVersion: 0,
    metadata: { title: 'Refund policy' },
    history: [],
    indexes: [],
    indexStatus: 'pending',
    indexErrorCode: null,
    imageBlobRefId: null,
    imageDescription: null,
    synonymVersion: 0,
  });
  segmentId = segment._id;
  await models.KnowledgeResourcePermission.create({
    workspaceId,
    knowledgeSpaceId: spaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    resourceType: 'space',
    resourceId: spaceId,
    principalType: 'member',
    principalId: memberId,
    permission: 'read',
    inheritMode: 'override',
    snapshotVersion: 1,
  });
  await models.KnowledgeModelBinding.create({
    workspaceId,
    knowledgeSpaceId: spaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    modelType: 'embedding',
    modelId: 'mock-embedding-768',
    displayName: 'Mock embedding 768',
    requiredCapabilities: ['text-embedding', 'dimension:768'],
    status: 'active',
    authorizedAt: new Date(),
  });
}

async function processS6Index(targetSegmentId: Types.ObjectId, text: string) {
  const jobs = new KnowledgeJobExecutionRepository(connection);
  const catalog = new S5MockModelCatalog();
  const segmentIndexes = new KnowledgeSegmentIndexRepository(connection, jobs, catalog);
  const current = await segmentIndexes.upsert(
    String(targetSegmentId),
    {
      indexId: 'default',
      type: 'default',
      text,
      modelId: 'mock-embedding-768',
      version: 1,
    },
    'create',
    context,
  );
  expect(current.indexStatus).toBe('pending');
  const processing = new S06ProcessingApplication({
    jobs,
    store: new S6ProcessingRepository(connection),
    artifacts: {
      async materialize() {
        throw new Error('not used by index fixture');
      },
    },
    processing: new S5ProcessingApplication(),
    vectors,
    fulltext: new KnowledgeFullTextRepository(connection),
    models: catalog,
    bindings: {
      async list() {
        return [
          {
            modelType: 'embedding',
            modelId: 'mock-embedding-768',
            displayName: 'Mock embedding 768',
            requiredCapabilities: ['text-embedding', 'dimension:768'],
            status: 'active',
          },
        ];
      },
    },
    port: {
      async parse() {
        throw new Error('not used by index fixture');
      },
      async embed() {
        return [Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0))];
      },
      async dispatchOutbox() {
        return true;
      },
    },
  });
  const indexJob = await connection.models.KnowledgeJob.findOne({
    workspaceId,
    kind: 'index',
    resourceId: String(targetSegmentId),
  }).lean();
  expect(indexJob).toBeTruthy();
  expect(
    await processing.handleQueue(
      'knowledge-index',
      String(indexJob!._id),
      `s7-s6-worker-${suffix}-${String(targetSegmentId)}`,
      context,
    ),
  ).toBe('succeeded');
  const indexed = await connection.models.KnowledgeSegment.findById(targetSegmentId).lean();
  expect(indexed?.indexStatus).toBe('indexed');
  expect(indexed?.fullTextVersion).toBeGreaterThan(0);
  expect(indexed?.indexes[0]).toMatchObject({
    indexId: 'default',
    modelId: 'mock-embedding-768',
    dimension: 768,
  });
  return indexed;
}

async function seedSecondSpace() {
  const models = registerKnowledgeModels(connection);
  const space = await models.KnowledgeSpace.create({
    workspaceId,
    knowledgeSpaceId: null,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    kind: 'space',
    parentSpaceId: null,
    name: `S7 S6 secondary ${suffix}`,
    normalizedName: `s7-s6-secondary-${suffix}`,
    description: '',
    iconKey: 'search',
    ownershipMemberId: memberId,
    accessMode: 'workspace',
    sourceAclMode: 'enforced',
    sourcePermissionEnabled: true,
    referenceRevision: 0,
    permissionRevision: 1,
    modelBindings: {},
    defaultChunking: {},
    status: 'active',
  });
  const source = await models.KnowledgeSource.create({
    workspaceId,
    knowledgeSpaceId: space._id,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    directoryId: null,
    kind: 'text',
    name: 'Refund review policy',
    externalId: null,
    connectorId: null,
    blobRefId: null,
    originalUrl: 'https://example.invalid/refund-review',
    mimeType: 'text/plain',
    sizeBytes: 56,
    contentHash: `secondary-source-${suffix}`,
    parseProvider: 'liteparse',
    processingStatus: 'ready',
    sourceVersion: 1,
    searchEnabled: true,
    permissionState: 'disabled',
    permissionRevision: 1,
    ownershipMemberId: memberId,
    metadata: {},
    tagValues: [],
  });
  const segment = await models.KnowledgeSegment.create({
    workspaceId,
    knowledgeSpaceId: space._id,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    sourceId: source._id,
    sourceVersion: 1,
    searchEnabled: true,
    order: 0,
    question: 'When does a refund need review?',
    answer: 'Refund review is required after thirty days.',
    content: 'Refund review is required after thirty days.',
    fullTextTokens: '',
    fullTextVersion: 0,
    metadata: { title: 'Refund review policy' },
    history: [],
    indexes: [],
    indexStatus: 'pending',
    indexErrorCode: null,
    imageBlobRefId: null,
    imageDescription: null,
    synonymVersion: 0,
  });
  await models.KnowledgeResourcePermission.create({
    workspaceId,
    knowledgeSpaceId: space._id,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    resourceType: 'space',
    resourceId: space._id,
    principalType: 'member',
    principalId: memberId,
    permission: 'read',
    inheritMode: 'override',
    snapshotVersion: 1,
  });
  await models.KnowledgeModelBinding.create({
    workspaceId,
    knowledgeSpaceId: space._id,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    modelType: 'embedding',
    modelId: 'mock-embedding-768',
    displayName: 'Mock embedding 768',
    requiredCapabilities: ['text-embedding', 'dimension:768'],
    status: 'active',
    authorizedAt: new Date(),
  });
  return { spaceId: space._id, sourceId: source._id, segmentId: segment._id };
}

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
  vectors = new KnowledgeVectorRepository(pool);
  s7Search = new S7SearchRepository(connection, new S5MockModelCatalog());
  authorization = new S7SearchAuthorizationAdapter(
    connection,
    new KnowledgeAccessRepository(connection),
  );
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await seed();
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

describe('C3 real S6 Job/Index output consumed by S7 recall', () => {
  it('indexes through S6 and returns the same Segment through fulltext, vector and final ACL', async () => {
    const segment = await processS6Index(segmentId, 'Refunds take five business days.');

    const fullTextHits = await s7Search.fullTextRecall(
      {
        knowledgeSpaceId: String(spaceId),
        sourceIds: [String(sourceId)],
        text: 'refund',
        limit: 100,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(fullTextHits).toHaveLength(1);
    expect(fullTextHits[0]).toMatchObject({
      segmentId: String(segmentId),
      sourceId: String(sourceId),
    });

    const vectorHits = await vectors.recall(
      {
        workspaceId,
        knowledgeSpaceId: String(spaceId),
        sourceIds: [String(sourceId)],
        dimension: 768,
        embeddingModelId: 'mock-embedding-768',
        vector: Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0)),
        limit: 100,
      },
      context,
    );
    expect(vectorHits).toHaveLength(1);
    expect(vectorHits[0]?.segmentId).toBe(String(segmentId));

    const pointer = segment!.indexes[0]!;
    const candidate: Candidate = {
      docId: `${String(spaceId)}:${String(segmentId)}`,
      segmentId: String(segmentId),
      sourceId: String(sourceId),
      knowledgeSpaceId: String(spaceId),
      score: vectorHits[0]!.score,
      embeddingScore: vectorHits[0]!.score,
      fullTextScore: fullTextHits[0]!.score,
      indexId: pointer.indexId,
      indexVersion: pointer.version,
      fullTextVersion: fullTextHits[0]!.fullTextVersion,
      scores: [],
      text: '',
    };
    const hydrated = await authorization.hydrate([candidate], context);
    expect(hydrated.rejected).toBe(0);
    expect(hydrated.items).toHaveLength(1);
    expect(hydrated.items[0]).toMatchObject({
      segmentId: String(segmentId),
      sourceId: String(sourceId),
      knowledgeSpaceId: String(spaceId),
    });
    expect(hydrated.items[0]?.text).toContain('five business days');

    const secondary = await seedSecondSpace();
    await processS6Index(secondary.segmentId, 'Refund review is required after thirty days.');
    const access = new KnowledgeAccessRepository(connection);
    const multiAuthorization = new S7SearchAuthorizationAdapter(connection, access);
    const catalog = new S5MockModelCatalog();
    const repository = new S7SearchRepository(connection, catalog);
    const gateway: S5ModelGatewayPort = {
      async invoke<T>(request): Promise<S5GatewayResult<T>> {
        const vector = Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0));
        const data =
          request.kind === 'embedding' ? { data: request.texts.map(() => vector) } : { data: null };
        return {
          data: data as T,
          actualModelId: request.modelId,
          attempts: 1,
          fallbackUsed: false,
          degraded: false,
          usage: { inputTokens: 1, outputTokens: 0, quantity: 1 },
        };
      },
    };
    const application = new S7SearchApplication({
      access: multiAuthorization,
      models: repository,
      filters: new S7FilterSourceRepository(connection),
      fullText: repository,
      authorization: multiAuthorization,
      pipeline: new S7SearchPipelineFactory({
        vectors,
        modelGateway: gateway,
        fullText: repository,
        authorization: multiAuthorization,
      }),
      citations: {
        async issueWithAudit(input) {
          return new Map<string, CitationApi>(
            input.candidates.map((item, index) => [
              `${item.knowledgeSpaceId}:${item.segmentId}`,
              {
                citationId: `cit_00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                segmentId: item.segmentId,
                sourceId: item.sourceId,
                title: item.source.name,
                sourceUrl: item.source.originalUrl,
                segmentRange: {
                  start: 0,
                  end: [...item.text].length,
                },
                score: item.score,
                version: item.segment.version,
              },
            ]),
          );
        },
        async findCurrent() {
          return null;
        },
      },
      audits: {
        async appendSearch() {},
      },
      now: () => new Date('2026-10-27T00:00:00Z'),
      searchIdFactory: () => 'search_00000000-0000-4000-8000-000000000001',
    });
    const multi = await application.searchMultiSpace(
      {
        knowledgeSpaceId: String(spaceId),
        knowledgeSpaceIds: [String(spaceId), String(secondary.spaceId)],
        query: 'refund',
        tokenBudget: 5_000,
        searchMode: 'hybrid',
        embeddingWeight: 0.5,
        rerankWeight: 0.5,
        usingRerank: false,
        similarity: 0.2,
      },
      context,
    );
    expect(multi.mode).toBe('multi_space');
    expect(multi.partial).toBe(false);
    expect(multi.items).toHaveLength(2);
    expect(new Set(multi.items.map((item) => item.segment.knowledgeSpaceId))).toEqual(
      new Set([String(spaceId), String(secondary.spaceId)]),
    );
    expect(new Set(multi.items.map((item) => item.citation.citationId)).size).toBe(2);
  }, 60_000);
});
