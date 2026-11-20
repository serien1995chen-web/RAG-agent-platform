import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Candidate } from '../../packages/search/src/index';
import { S7SearchAuthorizationAdapter } from '../../packages/service/src/modules/knowledge/adapter/s7-search-authorization.adapter';
import { KnowledgeAccessRepository } from '../../packages/service/src/modules/knowledge/repository/access.repository';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceA = `ws-kb-b16-a-${suffix}`;
const workspaceB = `ws-kb-b16-b-${suffix}`;
const memberA = `mem-kb-b16-a-${suffix}`;
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let authorization: S7SearchAuthorizationAdapter;
let spaceId: { toString(): string };
let sourceId: { toString(): string };
let segmentId: { toString(): string };

function context(workspaceId = workspaceA, scopes = ['knowledge:search']): TenantContext {
  return {
    workspaceId,
    memberId: memberA,
    requestId: `req-${suffix}`,
    traceId: suffix.padEnd(32, '0').slice(0, 32),
    scopes,
  };
}

async function seed() {
  const models = registerKnowledgeModels(connection);
  const space = await models.KnowledgeSpace.create({
    workspaceId: workspaceA,
    knowledgeSpaceId: null,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberA,
    updatedByMemberId: memberA,
    kind: 'space',
    parentSpaceId: null,
    name: `B16 ${suffix}`,
    normalizedName: `b16-${suffix}`,
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
    workspaceId: workspaceA,
    knowledgeSpaceId: spaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberA,
    updatedByMemberId: memberA,
    directoryId: null,
    kind: 'text',
    name: 'B16 authorized source',
    externalId: null,
    connectorId: null,
    blobRefId: null,
    originalUrl: null,
    mimeType: 'text/plain',
    sizeBytes: 20,
    contentHash: `hash-${suffix}`,
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
    workspaceId: workspaceA,
    knowledgeSpaceId: spaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberA,
    updatedByMemberId: memberA,
    sourceId,
    sourceVersion: 1,
    searchEnabled: true,
    order: 0,
    question: 'B16 authorization query',
    answer: 'Authorized B16 content',
    content: 'Authorized B16 content',
    fullTextTokens: 'b16 authorization query',
    fullTextVersion: 1,
    metadata: {},
    history: [],
    indexes: [
      {
        indexId: `idx-${suffix}`,
        type: 'default',
        modelId: 'qwen3.7-text-embedding',
        dimension: 1024,
        storageType: 'vector',
        vectorProfile: 'knowledge_segment_vectors_1024',
        vectorId: randomUUID(),
        text: 'Authorized B16 content',
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
  for (const resource of [
    { type: 'space', id: spaceId },
    { type: 'source', id: sourceId },
  ] as const) {
    await models.KnowledgeResourcePermission.create({
      workspaceId: workspaceA,
      knowledgeSpaceId: spaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: memberA,
      updatedByMemberId: memberA,
      resourceType: resource.type,
      resourceId: resource.id,
      principalType: 'member',
      principalId: memberA,
      permission: 'read',
      inheritMode: 'override',
      snapshotVersion: 1,
    });
  }
}

function candidate(): Candidate {
  return {
    docId: `${String(spaceId)}:${String(segmentId)}`,
    segmentId: String(segmentId),
    sourceId: String(sourceId),
    knowledgeSpaceId: String(spaceId),
    score: 0.9,
    embeddingScore: 0.9,
    scores: [{ type: 'embedding', value: 0.9, index: 0 }],
    text: '',
    indexId: `idx-${suffix}`,
    indexVersion: 1,
  };
}

beforeAll(async () => {
  const uri = new URL(requiredEnv('KB_TEST_MONGO_URI'));
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = await createKnowledgeMongoConnection(uri.toString());
  await ensureKnowledgeCollections(connection);
  authorization = new S7SearchAuthorizationAdapter(
    connection,
    new KnowledgeAccessRepository(connection),
  );
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId: { $in: [workspaceA, workspaceB] } });
  }
  await seed();
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId: { $in: [workspaceA, workspaceB] } });
  }
  await connection.close();
});

describe('B16 codexA final authorization', () => {
  it('L1-B16-A-SEARCH-001-A01 rejects cross-workspace candidates without leaking existence', async () => {
    const result = await authorization.hydrate([candidate()], context(workspaceB));
    expect(result.items).toEqual([]);
    expect(result.rejected).toBe(1);
  });

  it('L1-B16-A-SEARCH-001-A02 rejects a candidate after Source permission revocation', async () => {
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeSource.updateOne(
      { workspaceId: workspaceA, _id: sourceId },
      { $set: { permissionState: 'independent' }, $inc: { permissionRevision: 1, version: 1 } },
    );
    await models.KnowledgeResourcePermission.deleteMany({
      workspaceId: workspaceA,
      resourceType: 'source',
      resourceId: sourceId,
    });
    await models.KnowledgeSource.updateOne(
      { workspaceId: workspaceA, _id: sourceId },
      { $inc: { permissionRevision: 1, version: 1 } },
    );
    const result = await authorization.hydrate([candidate()], context());
    expect(result.items).toEqual([]);
    expect(result.rejected).toBe(1);
  });

  it('L1-B16-A-SEARCH-001-A03 rejects search-disabled Source and Segment state', async () => {
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeSource.updateOne(
      { workspaceId: workspaceA, _id: sourceId },
      { $set: { searchEnabled: false }, $inc: { permissionRevision: 1, version: 1 } },
    );
    expect((await authorization.hydrate([candidate()], context())).items).toEqual([]);
    await models.KnowledgeSource.updateOne(
      { workspaceId: workspaceA, _id: sourceId },
      { $set: { searchEnabled: true }, $inc: { permissionRevision: 1, version: 1 } },
    );
    await models.KnowledgeSegment.updateOne(
      { workspaceId: workspaceA, _id: segmentId },
      { $set: { searchEnabled: false }, $inc: { version: 1 } },
    );
    expect((await authorization.hydrate([candidate()], context())).items).toEqual([]);
  });

  it('L1-B16-A-SEARCH-001-A04 rejects a missing knowledge:search scope before persistence', () => {
    expect(() => authorization.assertSearchScope(context(workspaceA, []))).toThrow();
  });
});
