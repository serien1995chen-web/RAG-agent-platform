import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KnowledgeAccessRepository,
  KnowledgeApplication,
  KnowledgeAuditRepository,
  KnowledgeArchiveRepository,
  KnowledgeCatalogRepository,
  KnowledgeReferenceRepository,
  KnowledgeTagRepository,
} from '../../src/modules/knowledge';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s3_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s3_${suffix}`,
  requestId: `req_s3_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
};

let connection: mongoose.Connection;
let catalog: KnowledgeCatalogRepository;
let references: KnowledgeReferenceRepository;
let application: KnowledgeApplication;
let audits: KnowledgeAuditRepository;

async function run(input: {
  operationId: string;
  params?: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  context?: TenantContext;
}) {
  return application.dispatch({
    operationId: input.operationId,
    params: input.params ?? {},
    query: input.query ?? {},
    headers: input.headers ?? {},
    body: input.body ?? {},
    context: input.context ?? context,
  });
}

async function space(name: string) {
  return (
    await run({
      operationId: 'API-SPACE-CREATE',
      body: {
        kind: 'space',
        name,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
    })
  ).data as { id: string; version: number; referenceRevision: number };
}

async function folder(name: string, parentSpaceId: string | null = null) {
  return (
    await run({
      operationId: 'API-SPACE-CREATE',
      body: {
        kind: 'folder',
        parentSpaceId,
        name,
        accessMode: 'workspace',
        sourceAclMode: 'inherited',
        sourcePermissionEnabled: true,
      },
    })
  ).data as { id: string; version: number };
}

async function directory(spaceId: string, name: string, parentDirectoryId: string | null = null) {
  return (
    await run({
      operationId: 'API-DIRECTORY-CREATE',
      params: { spaceId },
      body: { name, parentDirectoryId },
    })
  ).data as { id: string; version: number; path: string[]; depth: number };
}

async function sourceIn(spaceId: string, name: string, directoryId: string | null = null) {
  return (
    await run({
      operationId: 'API-SOURCE-CREATE',
      params: { spaceId },
      body: { kind: 'text', name, directoryId },
    })
  ).data as { id: string; version: number; directoryId: string | null };
}

beforeAll(async () => {
  const uri = new URL(process.env.KB_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/kb_s3');
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  references = new KnowledgeReferenceRepository(connection);
  audits = new KnowledgeAuditRepository(connection);
  application = new KnowledgeApplication(
    catalog,
    new KnowledgeTagRepository(connection),
    new KnowledgeAccessRepository(connection),
    new KnowledgeArchiveRepository(connection),
    undefined,
    undefined,
    references,
    audits,
  );
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('TEST-KB-003-BLOCK catalog governance', () => {
  it('moves Space, Directory subtree and Source with CAS and parentPath', async () => {
    const destination = await folder(`Destination ${suffix}`);
    const targetSpace = await space(`Space ${suffix}`);
    const movedSpace = (
      await run({
        operationId: 'API-SPACE-MOVE',
        params: { spaceId: targetSpace.id },
        body: { targetParentId: destination.id, version: targetSpace.version },
      })
    ).data as { version: number; parentPath: string[] };
    expect(movedSpace.parentPath).toEqual([destination.id]);
    expect(movedSpace.version).toBe(targetSpace.version + 1);

    const parent = (
      await run({
        operationId: 'API-DIRECTORY-CREATE',
        params: { spaceId: targetSpace.id },
        body: { name: `Parent ${suffix}` },
      })
    ).data as { id: string; version: number };
    const child = (
      await run({
        operationId: 'API-DIRECTORY-CREATE',
        params: { spaceId: targetSpace.id },
        body: { name: `Child ${suffix}`, parentDirectoryId: parent.id },
      })
    ).data as { id: string; version: number; depth: number };
    const destinationDirectory = (
      await run({
        operationId: 'API-DIRECTORY-CREATE',
        params: { spaceId: targetSpace.id },
        body: { name: `Destination ${suffix}` },
      })
    ).data as { id: string; version: number };
    const movedDirectory = (
      await run({
        operationId: 'API-DIRECTORY-MOVE',
        params: { directoryId: parent.id },
        body: {
          targetParentId: destinationDirectory.id,
          version: parent.version,
        },
      })
    ).data as { version: number; parentPath: string[] };
    expect(movedDirectory.parentPath).toEqual([destinationDirectory.id]);
    expect(movedDirectory.version).toBe(parent.version + 1);
    const childAfter = await catalog.getDirectory(child.id, context);
    expect(childAfter.depth).toBe(2);
    expect(childAfter.path).toEqual([destinationDirectory.id, parent.id]);
    expect(childAfter.version).toBe(child.version + 1);

    const source = (
      await run({
        operationId: 'API-SOURCE-CREATE',
        params: { spaceId: targetSpace.id },
        body: { kind: 'text', name: `Source ${suffix}` },
      })
    ).data as { id: string; version: number };
    const movedSource = (
      await run({
        operationId: 'API-SOURCE-MOVE',
        params: { sourceId: source.id },
        body: { targetParentId: destinationDirectory.id, version: source.version },
      })
    ).data as { version: number; parentPath: string[]; directoryId: string };
    expect(movedSource.parentPath).toEqual([destinationDirectory.id]);
    expect(movedSource.directoryId).toBe(destinationDirectory.id);
  });

  it('enforces the database move matrix without partial writes', async () => {
    const rootFolder = await folder(`Cycle root ${suffix}`);
    const childFolder = await folder(`Cycle child ${suffix}`, rootFolder.id);
    await expect(
      catalog.moveSpace(
        rootFolder.id,
        { targetParentId: childFolder.id, version: rootFolder.version },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    await expect(
      catalog.moveSpace(
        childFolder.id,
        { targetParentId: childFolder.id, version: childFolder.version },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    expect((await catalog.getSpace(rootFolder.id, context)).version).toBe(rootFolder.version);
    expect((await catalog.getSpace(childFolder.id, context)).version).toBe(childFolder.version);

    const treeSpace = await space(`Move matrix space ${suffix}`);
    const cycleRoot = await directory(treeSpace.id, `Directory root ${suffix}`);
    const cycleChild = await directory(treeSpace.id, `Directory child ${suffix}`, cycleRoot.id);
    await expect(
      catalog.moveDirectoryTree(
        cycleRoot.id,
        { targetParentId: cycleRoot.id, version: cycleRoot.version },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    await expect(
      catalog.moveDirectoryTree(
        cycleRoot.id,
        { targetParentId: cycleChild.id, version: cycleRoot.version },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    expect((await catalog.getDirectory(cycleRoot.id, context)).version).toBe(cycleRoot.version);
    expect((await catalog.getDirectory(cycleChild.id, context)).path).toEqual([cycleRoot.id]);

    const depthOne = await directory(treeSpace.id, `Depth 1 ${suffix}`, cycleRoot.id);
    const depthTwo = await directory(treeSpace.id, `Depth 2 ${suffix}`, depthOne.id);
    const depthThree = await directory(treeSpace.id, `Depth 3 ${suffix}`, depthTwo.id);
    const depthFour = await directory(treeSpace.id, `Depth 4 ${suffix}`, depthThree.id);
    const depthLeaf = await directory(treeSpace.id, `Depth leaf ${suffix}`);
    await expect(
      catalog.moveDirectoryTree(
        depthLeaf.id,
        { targetParentId: depthFour.id, version: depthLeaf.version },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    expect((await catalog.getDirectory(depthLeaf.id, context)).version).toBe(depthLeaf.version);

    const duplicateTarget = await directory(treeSpace.id, `Duplicate target ${suffix}`);
    await directory(treeSpace.id, `Duplicate name ${suffix}`, duplicateTarget.id);
    const duplicateCandidate = await directory(treeSpace.id, `Duplicate name ${suffix}`);
    await expect(
      catalog.moveDirectoryTree(
        duplicateCandidate.id,
        { targetParentId: duplicateTarget.id, version: duplicateCandidate.version },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    expect((await catalog.getDirectory(duplicateCandidate.id, context)).version).toBe(
      duplicateCandidate.version,
    );

    const duplicateSpaceTarget = await folder(`Duplicate space target ${suffix}`);
    await folder(`Duplicate space name ${suffix}`, duplicateSpaceTarget.id);
    const duplicateSpaceCandidate = await folder(`Duplicate space name ${suffix}`);
    await expect(
      catalog.moveSpace(
        duplicateSpaceCandidate.id,
        { targetParentId: duplicateSpaceTarget.id, version: duplicateSpaceCandidate.version },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    expect((await catalog.getSpace(duplicateSpaceCandidate.id, context)).version).toBe(
      duplicateSpaceCandidate.version,
    );

    const foreignSpace = await space(`Foreign move space ${suffix}`);
    const foreignDirectory = await directory(foreignSpace.id, `Foreign target ${suffix}`);
    const source = await sourceIn(treeSpace.id, `Cross-space source ${suffix}`);
    await expect(
      catalog.moveSource(
        source.id,
        { targetParentId: foreignDirectory.id, version: source.version },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    expect(await catalog.getSource(source.id, context)).toMatchObject({
      id: source.id,
      version: source.version,
      directoryId: null,
    });

    const auditCount = await connection.models.KnowledgeAuditEvent.countDocuments({
      workspaceId,
      action: { $in: ['space.move', 'directory.move', 'source.move'] },
    });
    expect(auditCount).toBe(0);
  });

  it('returns 207 for a mixed batch and keeps successful items committed', async () => {
    const first = await space(`Batch A ${suffix}`);
    const second = await space(`Batch B ${suffix}`);
    const third = await space(`Batch C ${suffix}`);
    const destination = await folder(`Batch folder ${suffix}`);
    const result = (
      await run({
        operationId: 'API-SPACE-BATCH',
        body: {
          action: 'move',
          ids: [first.id, second.id, third.id],
          targetParentId: destination.id,
          versions: {
            [first.id]: first.version,
            [second.id]: second.version + 1,
            [third.id]: third.version,
          },
        },
      })
    ).data as {
      code?: string;
      succeeded: number;
      failed: number;
      items: Array<{ id: string; success: boolean; code?: string }>;
    };
    expect(result.code).toBe('KNOWLEDGE_PARTIAL_SUCCESS');
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.items[1]).toMatchObject({
      id: second.id,
      success: false,
      code: 'KNOWLEDGE_CONFLICT',
    });
    expect((await catalog.getSpace(first.id, context)).parentSpaceId).toBe(destination.id);
    expect((await catalog.getSpace(third.id, context)).parentSpaceId).toBe(destination.id);
    expect((await catalog.getSpace(second.id, context)).parentSpaceId).toBeNull();
  });

  it('accepts exactly 100 Space batch items and persists every success', async () => {
    const resources = [];
    for (let index = 0; index < 100; index += 1) {
      resources.push(await space(`Batch 100 ${index} ${suffix}`));
    }
    const destination = await folder(`Batch 100 destination ${suffix}`);
    const result = await run({
      operationId: 'API-SPACE-BATCH',
      body: {
        action: 'move',
        ids: resources.map((resource) => resource.id),
        targetParentId: destination.id,
        versions: Object.fromEntries(resources.map((resource) => [resource.id, resource.version])),
      },
    });
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ requested: 100, succeeded: 100, failed: 0 });
    const persisted = await Promise.all(
      resources.map((resource) => catalog.getSpace(resource.id, context)),
    );
    for (const [index, resource] of persisted.entries()) {
      expect(resource.parentSpaceId).toBe(destination.id);
      expect(resource.version).toBe(resources[index]!.version + 1);
    }
  }, 30_000);

  it('rejects 0, 101, duplicate IDs and inexact versions before item execution', async () => {
    const validId = new mongoose.Types.ObjectId().toString();
    const secondValidId = new mongoose.Types.ObjectId().toString();
    const ids101 = Array.from({ length: 101 }, () => new mongoose.Types.ObjectId().toString());
    const invalidBodies = [
      { field: 'ids', ids: [], versions: {} },
      {
        field: 'ids',
        ids: ids101,
        versions: Object.fromEntries(ids101.map((id, index) => [id, index + 1])),
      },
      { field: 'ids', ids: [validId, validId], versions: { [validId]: 1 } },
      { field: 'versions', ids: [validId, secondValidId], versions: { [validId]: 1 } },
      {
        field: 'versions',
        ids: [validId],
        versions: { [validId]: 1, [secondValidId]: 1 },
      },
    ];
    for (const input of invalidBodies) {
      await expect(
        run({
          operationId: 'API-SPACE-BATCH',
          body: {
            action: 'move',
            ids: input.ids,
            targetParentId: null,
            versions: input.versions,
          },
        }),
      ).rejects.toMatchObject({
        problem: {
          error: {
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            details: { field: input.field },
          },
        },
      });
    }
  });

  it('requires write permission on batch move targets', async () => {
    const destination = await folder(`Restricted batch folder ${suffix}`);
    const targetSpace = await space(`Restricted batch space ${suffix}`);
    const source = (
      await run({
        operationId: 'API-SOURCE-CREATE',
        params: { spaceId: targetSpace.id },
        body: { kind: 'text', name: `Restricted source ${suffix}` },
      })
    ).data as { id: string; version: number };
    const targetDirectory = (
      await run({
        operationId: 'API-DIRECTORY-CREATE',
        params: { spaceId: targetSpace.id },
        body: { name: `Restricted target directory ${suffix}` },
      })
    ).data as { id: string };
    const reader: TenantContext = {
      ...context,
      memberId: `mem_reader_${suffix}`,
    };
    await expect(
      run({
        operationId: 'API-SPACE-BATCH',
        context: reader,
        body: {
          action: 'move',
          ids: [targetSpace.id],
          targetParentId: destination.id,
          versions: { [targetSpace.id]: targetSpace.version },
        },
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    await expect(
      run({
        operationId: 'API-SOURCE-BATCH',
        context: reader,
        body: {
          action: 'move',
          ids: [source.id],
          targetDirectoryId: targetDirectory.id,
          versions: { [source.id]: source.version },
        },
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
  });

  it('returns ordered Source batch 207 results for stale versions and audits failures', async () => {
    const targetSpace = await space(`Source batch space ${suffix}`);
    const current = (
      await run({
        operationId: 'API-SOURCE-CREATE',
        params: { spaceId: targetSpace.id },
        body: { kind: 'text', name: `Source current ${suffix}` },
      })
    ).data as { id: string; version: number };
    const stale = (
      await run({
        operationId: 'API-SOURCE-CREATE',
        params: { spaceId: targetSpace.id },
        body: { kind: 'text', name: `Source stale ${suffix}` },
      })
    ).data as { id: string; version: number };
    const result = await run({
      operationId: 'API-SOURCE-BATCH',
      body: {
        action: 'move',
        ids: [current.id, stale.id],
        targetDirectoryId: null,
        versions: {
          [current.id]: current.version,
          [stale.id]: stale.version + 1,
        },
      },
    });
    expect(result.status).toBe(207);
    expect(result.data).toMatchObject({
      code: 'KNOWLEDGE_PARTIAL_SUCCESS',
      requested: 2,
      succeeded: 1,
      failed: 1,
    });
    const batch = result.data as {
      items: Array<{ id: string; success: boolean; code?: string }>;
    };
    expect(batch.items.map((item) => item.id)).toEqual([current.id, stale.id]);
    expect(batch.items[0]).toMatchObject({ id: current.id, success: true });
    expect(batch.items[1]).toMatchObject({
      id: stale.id,
      success: false,
      code: 'KNOWLEDGE_CONFLICT',
    });
    expect((await catalog.getSource(current.id, context)).directoryId).toBeNull();
    expect((await catalog.getSource(stale.id, context)).version).toBe(stale.version);
    const failedAudit = await connection.models.KnowledgeAuditEvent.findOne({
      workspaceId,
      action: 'batch.source.failed',
      resourceId: stale.id,
      outcome: 'failed',
    }).lean();
    expect(failedAudit).not.toBeNull();
  });

  it('TEST-OPS-003-BLOCK rolls back business data when audit or Outbox insertion fails', async () => {
    const destination = await folder(`Audit rollback folder ${suffix}`);
    const resource = await space(`Audit rollback space ${suffix}`);
    vi.spyOn(KnowledgeAuditRepository.prototype, 'append').mockRejectedValueOnce(
      new Error('injected audit failure'),
    );
    await expect(
      catalog.moveSpace(
        resource.id,
        { targetParentId: destination.id, version: resource.version },
        context,
      ),
    ).rejects.toThrow('injected audit failure');
    const afterAuditFailure = await catalog.getSpace(resource.id, context);
    expect(afterAuditFailure.parentSpaceId).toBeNull();
    expect(afterAuditFailure.version).toBe(resource.version);

    vi.restoreAllMocks();
    const deleteTarget = await space(`Outbox rollback space ${suffix}`);
    vi.spyOn(connection.models.KnowledgeOutboxEvent, 'create').mockRejectedValueOnce(
      new Error('injected outbox failure'),
    );
    await expect(
      catalog.deleteSpace(
        deleteTarget.id,
        {
          version: deleteTarget.version,
          expectedReferenceRevision: deleteTarget.referenceRevision,
          referenceStrategy: 'block',
        },
        context,
      ),
    ).rejects.toThrow('injected outbox failure');
    const afterOutboxFailure = await catalog.getSpace(deleteTarget.id, context);
    expect(afterOutboxFailure.status).toBe('active');
    expect(afterOutboxFailure.version).toBe(deleteTarget.version);
    expect(
      await connection.models.KnowledgeJob.countDocuments({
        workspaceId,
        resourceType: 'space',
        resourceId: deleteTarget.id,
      }),
    ).toBe(0);
  });

  it('TEST-X-REFERENCE-DELETE keeps revisions, stale bindings and removal blocking consistent', async () => {
    const target = await space(`Reference ${suffix}`);
    const first = await references.applyUpsert(
      {
        spaceId: target.id,
        referrerType: 'app',
        referrerId: `app_${suffix}`,
        referrerVersion: 'v1',
        referrerName: 'Reference app',
        registryRevision: 1,
      },
      context,
    );
    const second = await references.applyUpsert(
      {
        spaceId: target.id,
        referrerType: 'app',
        referrerId: `app_${suffix}`,
        referrerVersion: 'v2',
        referrerName: 'Reference app v2',
        registryRevision: 2,
      },
      context,
    );
    expect(first.referenceRevision).toBe(1);
    expect(second.referenceRevision).toBe(2);
    const replay = await references.applyUpsert(
      {
        spaceId: target.id,
        referrerType: 'app',
        referrerId: `app_${suffix}`,
        referrerVersion: 'v2',
        referrerName: 'Ignored replay name',
        registryRevision: 2,
      },
      context,
    );
    expect(replay.referenceRevision).toBe(2);
    const listed = await references.list(target.id, context);
    expect(listed.referenceRevision).toBe(2);
    expect(listed.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ referrerVersion: 'v1', status: 'stale' }),
        expect.objectContaining({ referrerVersion: 'v2', status: 'active' }),
      ]),
    );
    await expect(
      references.applyRemove(
        {
          spaceId: target.id,
          referrerType: 'app',
          referrerId: `app_${suffix}`,
          referrerVersion: 'v2',
          registryRevision: 1,
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    const current = await catalog.getSpace(target.id, context);
    await expect(
      run({
        operationId: 'API-SPACE-DELETE',
        params: { spaceId: target.id },
        body: {
          version: current.version,
          expectedReferenceRevision: current.referenceRevision,
          referenceStrategy: 'detach',
        },
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_REFERENCE_CONFLICT' } },
    });
    await references.applyRemove(
      {
        spaceId: target.id,
        referrerType: 'app',
        referrerId: `app_${suffix}`,
        referrerVersion: 'v2',
        registryRevision: 3,
      },
      context,
    );
    const removed = await connection.models.KnowledgeReferenceBinding.findOne({
      workspaceId,
      resourceType: 'space',
      resourceId: target.id,
      referrerVersion: 'v2',
    }).lean();
    expect(removed?.status).toBe('removed');
    expect(removed?.expiresAt).toBeInstanceOf(Date);
    expect(
      connection.models.KnowledgeReferenceBinding.schema
        .indexes()
        .some(([, options]) => options?.name === 'ttl_reference_binding'),
    ).toBe(true);
    const released = await catalog.getSpace(target.id, context);
    const deleted = await run({
      operationId: 'API-SPACE-DELETE',
      params: { spaceId: target.id },
      body: {
        version: released.version,
        expectedReferenceRevision: released.referenceRevision,
        referenceStrategy: 'block',
      },
    });
    expect(deleted.status).toBe(202);
    const auditCount = await connection.models.KnowledgeAuditEvent.countDocuments({
      workspaceId,
      action: {
        $in: ['space.move', 'directory.move', 'source.move', 'reference.upsert', 'space.delete'],
      },
    });
    expect(auditCount).toBeGreaterThan(0);
  });
});
