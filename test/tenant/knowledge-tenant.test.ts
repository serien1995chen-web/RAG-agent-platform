import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KnowledgeArchiveRepository,
  KnowledgeCatalogRepository,
  KnowledgeObjectRefRepository,
  KnowledgeReferenceRepository,
} from '../../packages/service/src/modules/knowledge';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceA = `ws_tenant_a_${suffix}`;
const workspaceB = `ws_tenant_b_${suffix}`;
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let repository: KnowledgeCatalogRepository;
let references: KnowledgeReferenceRepository;
let archive: KnowledgeArchiveRepository;
let objectRefs: KnowledgeObjectRefRepository;

function context(workspaceId: string): TenantContext {
  return {
    workspaceId,
    memberId: `member_${suffix}`,
    requestId: `req_${workspaceId}`,
    traceId: suffix.padEnd(32, '0').slice(0, 32),
    scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
  };
}

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  await ensureKnowledgeCollections(connection);
  repository = new KnowledgeCatalogRepository(connection);
  references = new KnowledgeReferenceRepository(connection);
  archive = new KnowledgeArchiveRepository(connection);
  objectRefs = new KnowledgeObjectRefRepository(connection);
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  const models = registerKnowledgeModels(connection);
  for (const model of Object.values(models)) {
    await model.deleteMany({ workspaceId: { $in: [workspaceA, workspaceB] } });
  }
  await connection.close();
});

describe('workspace tenant boundary', () => {
  it('never resolves a resource through another workspace even with the same id', async () => {
    const created = await repository.createSpace(
      {
        kind: 'space',
        name: `Tenant ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context(workspaceA),
    );
    await expect(repository.getSpace(created.id, context(workspaceB))).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
  });

  it('rejects missing workspace context instead of returning an empty result', async () => {
    await expect(
      repository.listSpaces({}, { ...context(workspaceA), workspaceId: '' }),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          details: { field: 'workspaceId' },
        },
      },
    });
  });

  it('rejects a move target from another workspace as not found', async () => {
    const source = await repository.createSpace(
      {
        kind: 'space',
        name: `Move source ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context(workspaceA),
    );
    const foreignFolder = await repository.createSpace(
      {
        kind: 'folder',
        name: `Foreign folder ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'inherited',
        sourcePermissionEnabled: true,
      },
      context(workspaceB),
    );
    await expect(
      repository.moveSpace(
        source.id,
        { targetParentId: foreignFolder.id, version: source.version },
        context(workspaceA),
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
  });

  it('rejects Directory and Source move targets from another workspace without writes', async () => {
    const localSpace = await repository.createSpace(
      {
        kind: 'space',
        name: `Local move space ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context(workspaceA),
    );
    const foreignSpace = await repository.createSpace(
      {
        kind: 'space',
        name: `Foreign move space ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context(workspaceB),
    );
    const localDirectory = await repository.createDirectory(
      localSpace.id,
      { name: `Local directory ${suffix}` },
      context(workspaceA),
    );
    const localSource = await repository.createSource(
      localSpace.id,
      { kind: 'text', name: `Local source ${suffix}` },
      context(workspaceA),
    );
    const foreignDirectory = await repository.createDirectory(
      foreignSpace.id,
      { name: `Foreign directory ${suffix}` },
      context(workspaceB),
    );

    await expect(
      repository.moveDirectoryTree(
        localDirectory.id,
        { targetParentId: foreignDirectory.id, version: localDirectory.version },
        context(workspaceA),
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    await expect(
      repository.moveSource(
        localSource.id,
        { targetParentId: foreignDirectory.id, version: localSource.version },
        context(workspaceA),
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });

    expect(await repository.getDirectory(localDirectory.id, context(workspaceA))).toMatchObject({
      id: localDirectory.id,
      version: localDirectory.version,
      parentDirectoryId: null,
    });
    expect(await repository.getSource(localSource.id, context(workspaceA))).toMatchObject({
      id: localSource.id,
      version: localSource.version,
      directoryId: null,
    });
  });

  it('does not resolve Export Jobs or export ObjectRefs across workspaces', async () => {
    const target = await repository.createSpace(
      {
        kind: 'space',
        name: `Export tenant ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context(workspaceA),
    );
    const job = await archive.createExportJob(
      {
        spaceId: target.id,
        sourceIds: [],
        idempotencyKey: `export-tenant-${suffix}`,
        exportScope: 'space',
      },
      context(workspaceA),
    );
    await expect(archive.get(String(job.jobId), context(workspaceB))).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });

    const objectRef = await connection.models.KnowledgeObjectRef.create({
      workspaceId: workspaceA,
      knowledgeSpaceId: target.id,
      version: 1,
      deletedAt: null,
      createdByMemberId: context(workspaceA).memberId,
      updatedByMemberId: context(workspaceA).memberId,
      provider: 'minio',
      bucket: 'kb-test',
      objectKey: `ws/${workspaceA}/space/${target.id}/export/${suffix}.zip`,
      purpose: 'export',
      sourceId: null,
      mimeType: 'application/zip',
      sizeBytes: 1,
      etag: 'etag',
      sha256: 'sha256',
      state: 'active',
      expiresAt: new Date(Date.now() + 60_000),
      upload: {
        originalName: 'export.zip',
      },
    });
    expect(await objectRefs.findObjectRef(String(objectRef._id), context(workspaceB))).toBeNull();
  });

  it('does not resolve or mutate references across workspaces', async () => {
    const target = await repository.createSpace(
      {
        kind: 'space',
        name: `Reference tenant ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context(workspaceA),
    );
    await expect(
      references.applyUpsert(
        {
          spaceId: target.id,
          referrerType: 'app',
          referrerId: `app_${suffix}`,
          referrerVersion: 'v1',
          referrerName: 'Cross tenant app',
          registryRevision: 1,
        },
        context(workspaceB),
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    await expect(references.list(target.id, context(workspaceB))).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    expect(
      await connection.models.KnowledgeReferenceBinding.countDocuments({
        workspaceId: workspaceB,
      }),
    ).toBe(0);
  });
});
