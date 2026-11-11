import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import {
  KnowledgeCatalogRepository,
  KnowledgeAccessRepository,
  KnowledgeJobExecutionRepository,
  KnowledgeSegmentIndexRepository,
  S06JobApplication,
} from '../../packages/service/src/modules/knowledge';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceA = `ws_b04_tenant_a_${suffix}`;
const workspaceB = `ws_b04_tenant_b_${suffix}`;
const contextA: TenantContext = {
  workspaceId: workspaceA,
  memberId: `mem_b04_a_${suffix}`,
  requestId: `req_b04_a_${suffix}`,
  traceId: suffix.padEnd(32, 'a').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: true,
};
const contextB: TenantContext = {
  workspaceId: workspaceB,
  memberId: `mem_b04_b_${suffix}`,
  requestId: `req_b04_b_${suffix}`,
  traceId: suffix.padEnd(32, 'b').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: true,
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let catalog: KnowledgeCatalogRepository;
let jobs: KnowledgeJobExecutionRepository;
let segmentIndexes: KnowledgeSegmentIndexRepository;
let knowledgeSpaceId = '';
let sourceId = '';
let segmentId = '';

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  jobs = new KnowledgeJobExecutionRepository(connection);
  segmentIndexes = new KnowledgeSegmentIndexRepository(connection, jobs, {
    async listModels() {
      return [];
    },
  });

  const models = registerKnowledgeModels(connection);
  const knowledgeSpaceObjectId = new connection.base.Types.ObjectId();
  const sourceObjectId = new connection.base.Types.ObjectId();
  const segmentObjectId = new connection.base.Types.ObjectId();
  knowledgeSpaceId = String(knowledgeSpaceObjectId);
  sourceId = String(sourceObjectId);
  segmentId = String(segmentObjectId);
  await models.KnowledgeSource.create({
    _id: sourceObjectId,
    workspaceId: workspaceA,
    knowledgeSpaceId: knowledgeSpaceObjectId,
    version: 1,
    deletedAt: null,
    createdByMemberId: contextA.memberId,
    updatedByMemberId: contextA.memberId,
    directoryId: null,
    kind: 'text',
    name: `B04 tenant source ${suffix}`,
    externalId: null,
    connectorId: null,
    blobRefId: new connection.base.Types.ObjectId(),
    originalUrl: null,
    mimeType: 'text/plain',
    sizeBytes: 128,
    contentHash: `b04-tenant-${suffix}`,
    parseProvider: 'liteparse',
    processingStatus: 'ready',
    sourceVersion: 1,
    searchEnabled: true,
    permissionState: 'disabled',
    permissionRevision: 0,
    ownershipMemberId: contextA.memberId,
    metadata: {},
    tagValues: [],
  });
  await models.KnowledgeSegment.create({
    _id: segmentObjectId,
    workspaceId: workspaceA,
    knowledgeSpaceId: knowledgeSpaceObjectId,
    version: 3,
    deletedAt: null,
    createdByMemberId: contextA.memberId,
    updatedByMemberId: contextA.memberId,
    sourceId: sourceObjectId,
    sourceVersion: 1,
    searchEnabled: true,
    order: 0,
    question: 'Workspace A secret Segment',
    answer: 'Workspace A answer',
    content: 'Workspace A secret Segment\nWorkspace A answer',
    fullTextTokens: '',
    fullTextVersion: 0,
    metadata: {},
    history: [
      {
        version: 2,
        question: 'Workspace A prior secret',
        answer: 'Workspace A prior answer',
        changedAt: new Date('2026-11-11T00:00:00.000Z'),
        changedByMemberId: contextA.memberId,
      },
    ],
    indexes: [],
    indexStatus: 'indexed',
    indexErrorCode: null,
    imageBlobRefId: null,
    imageDescription: null,
    synonymVersion: 0,
  });
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({
      workspaceId: { $in: [workspaceA, workspaceB] },
    });
  }
  await connection.close();
});

describe('B04 tenant isolation', () => {
  it('L1-B04-DATA-001-A01 foreign Segment detail update search toggle and delete remain hidden', async () => {
    const segmentIdText = segmentId;
    await expect(catalog.getSegment(segmentIdText, contextB)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    await expect(
      catalog.updateSegment(
        segmentIdText,
        { question: 'foreign overwrite', searchEnabled: false, version: 3 },
        contextB,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: expect.stringMatching(/KNOWLEDGE_(NOT_FOUND|CONFLICT)/) } },
    });
    await expect(catalog.deleteSegment(segmentIdText, contextB, 3)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    expect(await catalog.getSegment(segmentIdText, contextA)).toMatchObject({
      question: 'Workspace A secret Segment',
      searchEnabled: true,
      version: 3,
    });
  });

  it('L1-B04-DATA-002-A01 foreign index history and index mutations expose no resource existence', async () => {
    const segmentIdText = segmentId;
    await expect(segmentIndexes.history(segmentIdText, contextB)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    await expect(
      segmentIndexes.upsert(
        segmentIdText,
        {
          indexId: 'foreign_custom',
          type: 'custom',
          text: 'must not write',
          modelId: 'mock-embedding-768',
          version: 3,
        },
        'create',
        contextB,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: expect.stringMatching(/KNOWLEDGE_(NOT_FOUND|CONFLICT)/) } },
    });
    await expect(
      segmentIndexes.remove(segmentIdText, 'foreign_custom', 3, contextB),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
    expect((await segmentIndexes.history(segmentIdText, contextA)).items).toHaveLength(1);
  });

  it('L1-B04-DATA-003-A01 foreign Job status is hidden and missing tenant context fails closed', async () => {
    const job = await jobs.create(
      {
        kind: 'index',
        resourceType: 'segment',
        resourceId: segmentId,
        knowledgeSpaceId,
        inputSnapshot: { segmentVersion: 3 },
        priority: 5,
        idempotencyKey: `b04-tenant-job-${suffix}`,
      },
      contextA,
    );
    await expect(jobs.getRaw(job.jobId, contextB)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    await expect(
      segmentIndexes.history(segmentId, { memberId: contextA.memberId } as TenantContext),
    ).rejects.toBeTruthy();
  });

  it('L1-B04-DATA-001-A02 Viewer reads, Editor writes, and only Manager deletes', async () => {
    const models = registerKnowledgeModels(connection);
    const aclSpaceId = new connection.base.Types.ObjectId();
    const viewerId = `mem_b04_viewer_${suffix}`;
    const editorId = `mem_b04_editor_${suffix}`;
    const managerId = `mem_b04_manager_${suffix}`;
    await models.KnowledgeSpace.create({
      _id: aclSpaceId,
      workspaceId: workspaceA,
      knowledgeSpaceId: null,
      version: 1,
      deletedAt: null,
      createdByMemberId: contextA.memberId,
      updatedByMemberId: contextA.memberId,
      kind: 'space',
      parentSpaceId: null,
      name: `B04 role space ${suffix}`,
      normalizedName: `b04-role-${suffix}`,
      description: '',
      iconKey: 'book-open',
      ownershipMemberId: contextA.memberId,
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
      { workspaceId: workspaceA, _id: sourceId },
      { $set: { knowledgeSpaceId: aclSpaceId, permissionState: 'disabled' } },
    );
    for (const [memberId, permission] of [
      [viewerId, 'read'],
      [editorId, 'write'],
      [managerId, 'manage'],
    ] as const) {
      await models.KnowledgeResourcePermission.create({
        workspaceId: workspaceA,
        knowledgeSpaceId: aclSpaceId,
        version: 1,
        deletedAt: null,
        createdByMemberId: contextA.memberId,
        updatedByMemberId: contextA.memberId,
        resourceType: 'space',
        resourceId: aclSpaceId,
        principalType: 'member',
        principalId: memberId,
        permission,
        inheritMode: 'override',
        snapshotVersion: 1,
      });
    }
    const access = new KnowledgeAccessRepository(connection);
    const asMember = (memberId: string): TenantContext => ({
      ...contextA,
      memberId,
      isWorkspaceOwner: false,
    });

    await expect(
      access.assertPermission('source', sourceId, 'read', asMember(viewerId)),
    ).resolves.toMatchObject({ effectivePermission: 'read' });
    await expect(
      access.assertPermission('source', sourceId, 'write', asMember(viewerId)),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    await expect(
      access.assertPermission('source', sourceId, 'write', asMember(editorId)),
    ).resolves.toMatchObject({ effectivePermission: 'write' });
    await expect(
      access.assertPermission('source', sourceId, 'manage', asMember(editorId)),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    const batchApplication = new S06JobApplication(jobs, segmentIndexes, catalog, access);
    await expect(
      batchApplication.dispatch({
        operationId: 'API-SEGMENT-BATCH',
        params: {},
        query: {},
        headers: {},
        body: { action: 'delete', items: [{ id: segmentId, version: 3 }] },
        context: asMember(editorId),
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    await expect(
      access.assertPermission('source', sourceId, 'manage', asMember(managerId)),
    ).resolves.toMatchObject({ effectivePermission: 'manage' });
  });
});
