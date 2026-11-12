import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KnowledgeAccessRepository,
  KnowledgeCatalogRepository,
  KnowledgeJobExecutionRepository,
  KnowledgeSegmentIndexRepository,
  S06JobApplication,
} from '../../packages/service/src/modules/knowledge';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceA = `ws_b05_tenant_a_${suffix}`;
const workspaceB = `ws_b05_tenant_b_${suffix}`;
const ownerId = `mem_b05_owner_${suffix}`;
const viewerId = `mem_b05_viewer_${suffix}`;
const editorId = `mem_b05_editor_${suffix}`;
const nonMemberId = `mem_b05_nonmember_${suffix}`;
const contextA: TenantContext = {
  workspaceId: workspaceA,
  memberId: ownerId,
  requestId: `req_b05_tenant_a_${suffix}`,
  traceId: suffix.padEnd(32, 'a').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: true,
};
const contextB: TenantContext = {
  ...contextA,
  workspaceId: workspaceB,
  memberId: `mem_b05_tenant_b_${suffix}`,
  requestId: `req_b05_tenant_b_${suffix}`,
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let catalog: KnowledgeCatalogRepository;
let s06: S06JobApplication;
let sourceId = '';

function asMember(memberId: string): TenantContext {
  return {
    ...contextA,
    memberId,
    isWorkspaceOwner: false,
  };
}

function item(question: string) {
  return { sourceId, question, answer: `${question} answer` };
}

async function seedAclFixture() {
  const models = registerKnowledgeModels(connection);
  const spaceObjectId = new connection.base.Types.ObjectId();
  const sourceObjectId = new connection.base.Types.ObjectId();
  sourceId = String(sourceObjectId);
  await models.KnowledgeSpace.create({
    _id: spaceObjectId,
    workspaceId: workspaceA,
    knowledgeSpaceId: null,
    version: 1,
    deletedAt: null,
    createdByMemberId: ownerId,
    updatedByMemberId: ownerId,
    kind: 'space',
    parentSpaceId: null,
    name: `B05 tenant Space ${suffix}`,
    normalizedName: `b05-tenant-${suffix}`,
    description: '',
    iconKey: 'book-open',
    ownershipMemberId: ownerId,
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
    workspaceId: workspaceA,
    knowledgeSpaceId: spaceObjectId,
    version: 1,
    deletedAt: null,
    createdByMemberId: ownerId,
    updatedByMemberId: ownerId,
    directoryId: null,
    kind: 'text',
    name: `B05 tenant Source ${suffix}`,
    externalId: null,
    connectorId: null,
    blobRefId: new connection.base.Types.ObjectId(),
    originalUrl: null,
    mimeType: 'text/plain',
    sizeBytes: 128,
    contentHash: `b05-tenant-${suffix}`,
    parseProvider: 'liteparse',
    processingStatus: 'ready',
    sourceVersion: 1,
    searchEnabled: true,
    permissionState: 'disabled',
    permissionRevision: 0,
    ownershipMemberId: ownerId,
    metadata: {},
    tagValues: [],
  });
  for (const [memberId, permission] of [
    [viewerId, 'read'],
    [editorId, 'write'],
  ] as const) {
    await models.KnowledgeResourcePermission.create({
      workspaceId: workspaceA,
      knowledgeSpaceId: spaceObjectId,
      version: 1,
      deletedAt: null,
      createdByMemberId: ownerId,
      updatedByMemberId: ownerId,
      resourceType: 'space',
      resourceId: spaceObjectId,
      principalType: 'member',
      principalId: memberId,
      permission,
      inheritMode: 'override',
      snapshotVersion: 1,
    });
  }
}

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  const jobs = new KnowledgeJobExecutionRepository(connection);
  const access = new KnowledgeAccessRepository(connection);
  const segmentIndexes = new KnowledgeSegmentIndexRepository(connection, jobs, {
    async listModels() {
      return [];
    },
  });
  s06 = new S06JobApplication(jobs, segmentIndexes, catalog, access);
}, 60_000);

beforeEach(async () => {
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({
      workspaceId: { $in: [workspaceA, workspaceB] },
    });
  }
  await seedAclFixture();
});

afterAll(async () => {
  if (!connection) return;
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({
      workspaceId: { $in: [workspaceA, workspaceB] },
    });
  }
  await connection.close();
});

describe('B05 manual data tenant and role boundaries', () => {
  it('L1-B05-DATA-004-A01 rejects a mixed foreign batch without writing any legal item', async () => {
    const result = await s06
      .dispatch({
        operationId: 'API-SEGMENT-BATCH',
        params: {},
        query: {},
        headers: {},
        body: {
          action: 'upsert',
          items: [item('legal-looking item'), item('foreign item')],
        },
        context: contextB,
      })
      .catch((error) => error);
    expect(result).toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    expect(
      await connection.models.KnowledgeSegment.countDocuments({
        workspaceId: { $in: [workspaceA, workspaceB] },
      }),
    ).toBe(0);
  });

  it('L1-B05-DATA-004-A02 Viewer cannot insert, Editor can insert, and Non-member is hidden', async () => {
    await expect(
      s06.dispatch({
        operationId: 'API-SEGMENT-BATCH',
        params: {},
        query: {},
        headers: {},
        body: { action: 'upsert', items: [item('viewer cannot write')] },
        context: asMember(viewerId),
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    await expect(
      s06.dispatch({
        operationId: 'API-SEGMENT-BATCH',
        params: {},
        query: {},
        headers: {},
        body: { action: 'upsert', items: [item('editor can write')] },
        context: asMember(editorId),
      }),
    ).resolves.toMatchObject({ status: 200, data: { succeeded: 1, failed: 0 } });
    await expect(
      s06.dispatch({
        operationId: 'API-SEGMENT-BATCH',
        params: {},
        query: {},
        headers: {},
        body: { action: 'upsert', items: [item('non-member cannot write')] },
        context: asMember(nonMemberId),
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    expect(
      await connection.models.KnowledgeSegment.countDocuments({ workspaceId: workspaceA }),
    ).toBe(1);
  });

  it('L1-B05-ING-002-A01 hides foreign directories and enforces missing tenant context', async () => {
    const requests = new KnowledgeCatalogRepository(connection);
    await expect(
      requests.createSegment(sourceId, item('foreign source write'), contextB),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    await expect(
      requests.createSegment(sourceId, item('missing tenant'), {
        ...contextA,
        workspaceId: '',
        requestId: 'req_b05_missing_workspace',
      } as TenantContext),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });
});
