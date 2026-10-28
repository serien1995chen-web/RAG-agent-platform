import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Candidate } from '@kb/search';
import { compileSearchFilter } from '@kb/search';
import { S7SearchAuthorizationAdapter } from '../../src/modules/knowledge/adapter/s7-search-authorization.adapter';
import { KnowledgeAccessRepository } from '../../src/modules/knowledge/repository/access.repository';
import { S7FilterSourceRepository } from '../../src/modules/knowledge/repository/s7-filter-source.repository';
import { S7SearchRepository } from '../../src/modules/knowledge/repository/s7-search.repository';
import { S5MockModelCatalog } from '../../src/modules/knowledge/adapter/s5-aiproxy-catalog.adapter';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s7_data_${suffix}`;
const memberId = `mem_s7_data_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId,
  requestId: `req-s7-data-${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:search', 'knowledge:read'],
};

let connection: mongoose.Connection;
let spaceId: Types.ObjectId;
let sourceId: Types.ObjectId;
let segmentId: Types.ObjectId;
let authorization: S7SearchAuthorizationAdapter;
let filters: S7FilterSourceRepository;
let search: S7SearchRepository;

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    docId: `${String(spaceId)}:${String(segmentId)}`,
    segmentId: String(segmentId),
    sourceId: String(sourceId),
    knowledgeSpaceId: String(spaceId),
    score: 0.9,
    embeddingScore: 0.9,
    scores: [{ type: 'embedding', value: 0.9, index: 0 }],
    text: '',
    indexId: 'idx-s7',
    indexVersion: 1,
    ...overrides,
  };
}

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
    name: `S7 ${suffix}`,
    normalizedName: `s7-${suffix}`,
    description: '',
    iconKey: 'search',
    ownershipMemberId: `owner-${suffix}`,
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
    sizeBytes: 20,
    contentHash: 'refund-hash',
    parseProvider: 'liteparse',
    processingStatus: 'ready',
    sourceVersion: 1,
    searchEnabled: true,
    permissionState: 'disabled',
    permissionRevision: 1,
    ownershipMemberId: `owner-${suffix}`,
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
    searchEnabled: true,
    order: 0,
    question: 'How long does a refund take?',
    answer: 'Refunds take five business days.',
    content: 'Refunds take five business days.',
    fullTextTokens: 'refund refunds policy five business days',
    metadata: { section: 'payments' },
    history: [],
    indexes: [
      {
        indexId: 'idx-s7',
        type: 'default',
        modelId: 'mock-embedding-1536',
        dimension: 1536,
        storageType: 'vector',
        vectorProfile: 'knowledge_segment_vectors_1536',
        vectorId: '00000000-0000-5000-8000-000000000001',
        text: 'Refunds take five business days.',
        version: 1,
      },
    ],
    indexStatus: 'indexed',
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
    modelId: 'mock-embedding-1536',
    displayName: 'Mock embedding 1536',
    requiredCapabilities: ['text-embedding', 'dimension:1536'],
    status: 'active',
    authorizedAt: new Date(),
  });
}

beforeAll(async () => {
  const uri = new URL(requiredEnv('KB_TEST_MONGO_URI'));
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  const access = new KnowledgeAccessRepository(connection);
  authorization = new S7SearchAuthorizationAdapter(connection, access);
  filters = new S7FilterSourceRepository(connection);
  search = new S7SearchRepository(connection, new S5MockModelCatalog());
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await seed();
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('TEST-SEARCH-001/002/005-BLOCK S7 Mongo data integration', () => {
  it('recalls Mongo $text candidates and hydrates the indexed Segment', async () => {
    const hits = await search.fullTextRecall(
      {
        knowledgeSpaceId: String(spaceId),
        sourceIds: [String(sourceId)],
        text: 'refund',
        limit: 10,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      segmentId: String(segmentId),
      sourceId: String(sourceId),
    });
    const hydrated = await authorization.hydrate(
      [
        {
          ...candidate({ indexId: undefined, indexVersion: undefined }),
          scores: [{ type: 'fullText', value: hits[0]!.score, index: 0 }],
          fullTextScore: hits[0]!.score,
        },
      ],
      context,
    );
    expect(hydrated.rejected).toBe(0);
    expect(hydrated.items[0]?.segment.content).toContain('five business days');
  });

  it('drops revoked, disabled and stale index candidates after recall', async () => {
    const models = registerKnowledgeModels(connection);
    expect((await authorization.hydrate([candidate()], context)).items).toHaveLength(1);

    await models.KnowledgeSource.updateOne(
      { workspaceId, _id: sourceId },
      { $set: { searchEnabled: false }, $inc: { version: 1, permissionRevision: 1 } },
    );
    expect((await authorization.hydrate([candidate()], context)).items).toHaveLength(0);

    await models.KnowledgeSource.updateOne(
      { workspaceId, _id: sourceId },
      { $set: { searchEnabled: true } },
    );
    expect(
      (await authorization.hydrate([candidate({ indexVersion: 99 })], context)).items,
    ).toHaveLength(0);

    await models.KnowledgeResourcePermission.deleteMany({
      workspaceId,
      resourceType: 'space',
      resourceId: spaceId,
    });
    expect((await authorization.hydrate([candidate()], context)).items).toHaveLength(0);
  });

  it('requires current Space read ACL even when the Source has independent permission', async () => {
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeSource.updateOne(
      { workspaceId, _id: sourceId },
      { $set: { permissionState: 'independent' }, $inc: { version: 1 } },
    );
    await models.KnowledgeResourcePermission.create({
      workspaceId,
      knowledgeSpaceId: spaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: memberId,
      updatedByMemberId: memberId,
      resourceType: 'source',
      resourceId: sourceId,
      principalType: 'member',
      principalId: memberId,
      permission: 'read',
      inheritMode: 'override',
      snapshotVersion: 1,
    });
    expect((await authorization.hydrate([candidate()], context)).items).toHaveLength(1);

    await models.KnowledgeResourcePermission.deleteMany({
      workspaceId,
      resourceType: 'space',
      resourceId: spaceId,
    });
    expect((await authorization.hydrate([candidate()], context)).items).toHaveLength(0);
  });

  it('rejects stale Segment source versions and missing full-text versions', async () => {
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeSource.updateOne(
      { workspaceId, _id: sourceId },
      { $set: { sourceVersion: 2 }, $inc: { version: 1, permissionRevision: 1 } },
    );
    await models.KnowledgeSegment.updateOne(
      { workspaceId, _id: segmentId },
      { $set: { sourceVersion: 1, fullTextVersion: 1 } },
    );
    expect((await authorization.hydrate([candidate()], context)).items).toHaveLength(0);

    await models.KnowledgeSource.updateOne(
      { workspaceId, _id: sourceId },
      { $set: { sourceVersion: 1 } },
    );
    await models.KnowledgeSegment.updateOne(
      { workspaceId, _id: segmentId },
      { $unset: { fullTextVersion: 1 } },
    );
    const fullTextCandidate = {
      ...candidate({ indexId: undefined, indexVersion: undefined }),
      scores: [{ type: 'fullText' as const, value: 1, index: 0 }],
      fullTextScore: 1,
      fullTextVersion: 1,
    };
    expect((await authorization.hydrate([fullTextCandidate], context)).items).toHaveLength(0);
  });

  it('builds tag filter facts and resolves active bindings from Mongo', async () => {
    const models = registerKnowledgeModels(connection);
    const tagId = new Types.ObjectId();
    await models.KnowledgeTag.create({
      _id: tagId,
      workspaceId,
      knowledgeSpaceId: spaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: memberId,
      updatedByMemberId: memberId,
      key: 'department',
      label: 'Department',
      tagType: 'string',
      options: ['support'],
      required: false,
      status: 'active',
    });
    await models.KnowledgeSource.updateOne(
      { workspaceId, _id: sourceId },
      { $set: { tagValues: [{ tagId, valueKey: 'support', value: 'support' }] } },
    );
    const facts = await filters.listFilterFacts(String(spaceId), undefined, context);
    expect(facts.definitions).toHaveLength(1);
    const compiled = compileSearchFilter(
      {
        logic: 'AND',
        conditions: [
          {
            tagId: String(tagId),
            tagType: 'string',
            operator: '$eq',
            value: 'support',
          },
        ],
      },
      facts.facts,
      facts.definitions,
    );
    expect(compiled.allowedSourceIds).toEqual([String(sourceId)]);

    const modelsResolved = await search.resolveModels(String(spaceId), false, context);
    expect(modelsResolved.embedding).toEqual({
      modelId: 'mock-embedding-1536',
      dimension: 1536,
    });
  });
});
