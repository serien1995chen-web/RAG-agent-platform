import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KnowledgeAccessRepository,
  KnowledgeApplication,
  KnowledgeArchiveRepository,
  KnowledgeAuditRepository,
  KnowledgeCatalogRepository,
  KnowledgeReferenceRepository,
  KnowledgeTagRepository,
} from '../../src/modules/knowledge';
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
const workspaceId = `ws_b01_${suffix}`;
const otherWorkspaceId = `ws_b01_other_${suffix}`;
const memberId = `mem_b01_${suffix}`;
const otherMemberId = `mem_b01_other_${suffix}`;
const traceId = suffix.padEnd(32, '0').slice(0, 32);
const owner: TenantContext = {
  workspaceId,
  memberId,
  requestId: `req_b01_${suffix}`,
  traceId,
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: false,
};
const foreign: TenantContext = {
  ...owner,
  workspaceId: otherWorkspaceId,
  memberId: `${otherMemberId}_foreign`,
};

let connection: mongoose.Connection;
let catalog: KnowledgeCatalogRepository;
let access: KnowledgeAccessRepository;
let references: KnowledgeReferenceRepository;
let application: KnowledgeApplication;

async function run(input: {
  operationId: string;
  params?: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  context?: TenantContext;
}) {
  return application.dispatch({
    operationId: input.operationId,
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body ?? {},
    context: input.context ?? owner,
  });
}

function spaceBody(name: string, input: Record<string, unknown> = {}) {
  return {
    kind: 'space',
    name,
    description: 'B01 lifecycle fixture',
    iconKey: 'book-open',
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
    ...input,
  };
}

async function createSpace(name: string, input: Record<string, unknown> = {}) {
  return (await run({ operationId: 'API-SPACE-CREATE', body: spaceBody(name, input) })).data as {
    id: string;
    version: number;
    referenceRevision: number;
    parentSpaceId: string | null;
    parentPath: string[];
    modelBindings: Record<string, unknown>;
  };
}

beforeAll(async () => {
  const uri = new URL(requiredEnv('KB_TEST_MONGO_URI'));
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  access = new KnowledgeAccessRepository(connection);
  references = new KnowledgeReferenceRepository(connection);
  application = new KnowledgeApplication(
    catalog,
    new KnowledgeTagRepository(connection),
    access,
    new KnowledgeArchiveRepository(connection),
    undefined,
    undefined,
    references,
    new KnowledgeAuditRepository(connection),
  );
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId: { $in: [workspaceId, otherWorkspaceId] } });
  }
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId: { $in: [workspaceId, otherWorkspaceId] } });
  }
  await connection.close();
});

describe('B01 knowledge-space lifecycle', () => {
  it('L1-B01-KB-001-P01 creates, lists, opens, updates and soft-deletes one Space', async () => {
    const created = await createSpace(`Lifecycle ${suffix}`);
    const listed = (await run({ operationId: 'API-SPACE-LIST' })).data as {
      items: Array<{ id: string }>;
    };
    expect(listed.items.some((item) => item.id === created.id)).toBe(true);
    expect(
      (await run({ operationId: 'API-SPACE-GET', params: { spaceId: created.id } })).data,
    ).toMatchObject({ id: created.id });

    const updated = (
      await run({
        operationId: 'API-SPACE-UPDATE',
        params: { spaceId: created.id },
        body: { version: created.version, name: `Renamed ${suffix}`, description: 'persisted' },
      })
    ).data as { id: string; name: string; description: string; version: number };
    expect(updated).toMatchObject({
      id: created.id,
      name: `Renamed ${suffix}`,
      description: 'persisted',
      version: created.version + 1,
    });
    expect(
      (await run({ operationId: 'API-SPACE-GET', params: { spaceId: created.id } })).data,
    ).toMatchObject({ name: `Renamed ${suffix}`, description: 'persisted' });

    const deleted = await run({
      operationId: 'API-SPACE-DELETE',
      params: { spaceId: created.id },
      body: {
        version: updated.version,
        expectedReferenceRevision: created.referenceRevision,
        referenceStrategy: 'block',
      },
    });
    expect(deleted.status).toBe(202);
    const afterDelete = (await run({ operationId: 'API-SPACE-LIST' })).data as {
      items: Array<{ id: string }>;
    };
    expect(afterDelete.items.some((item) => item.id === created.id)).toBe(false);
  });

  it('L1-B01-KB-001-N01 allows two active sibling Spaces with the same name', async () => {
    const first = await createSpace(`Same sibling ${suffix}`);
    const second = await createSpace(`Same sibling ${suffix}`);
    expect(first.id).not.toBe(second.id);
    expect(await catalog.listSpaces({ limit: 100 }, owner)).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: first.id, name: `Same sibling ${suffix}` }),
        expect.objectContaining({ id: second.id, name: `Same sibling ${suffix}` }),
      ]),
    });
  });

  it('L1-B01-KB-001-N02 rejects invalid enums/counts and does not persist unknown fields', async () => {
    await expect(
      run({ operationId: 'API-SPACE-CREATE', body: spaceBody('') }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    await expect(
      run({ operationId: 'API-SPACE-CREATE', body: spaceBody('x'.repeat(121)) }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    await expect(
      run({
        operationId: 'API-SPACE-CREATE',
        body: spaceBody('Unknown kind', { kind: 'unknown' }),
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    await expect(
      run({
        operationId: 'API-SPACE-CREATE',
        body: spaceBody('Unknown ACL', { sourceAclMode: 'public' }),
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });

    const created = await createSpace(`Unknown field ${suffix}`, {
      ignoredByContract: 'must-not-persist',
    });
    const raw = await connection.models.KnowledgeSpace.findById(created.id).lean();
    expect(raw).not.toHaveProperty('ignoredByContract');
  });

  it('L1-B01-KB-001-A01 hides foreign resource existence and never mutates it', async () => {
    const created = await createSpace(`Tenant protected ${suffix}`);
    for (const operation of [
      { operationId: 'API-SPACE-GET', params: { spaceId: created.id }, body: {} },
      {
        operationId: 'API-SPACE-UPDATE',
        params: { spaceId: created.id },
        body: { version: created.version, name: 'foreign write' },
      },
      {
        operationId: 'API-SPACE-DELETE',
        params: { spaceId: created.id },
        body: {
          version: created.version,
          expectedReferenceRevision: created.referenceRevision,
          referenceStrategy: 'block',
        },
      },
    ]) {
      const error = await run({ ...operation, context: foreign }).catch((caught) => caught);
      expect(error).toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
      });
      expect(JSON.stringify(error)).not.toContain(`Tenant protected ${suffix}`);
    }
    expect(await catalog.getSpace(created.id, owner)).toMatchObject({
      id: created.id,
      name: `Tenant protected ${suffix}`,
      version: created.version,
    });
  });

  it('L1-B01-KB-001-S01 atomically creates and retires Space ACL, Job, Outbox and audit', async () => {
    const created = await createSpace(`Transactional ${suffix}`);
    const models = registerKnowledgeModels(connection);
    expect(
      await models.KnowledgeResourcePermission.countDocuments({
        workspaceId,
        resourceType: 'space',
        resourceId: created.id,
        deletedAt: null,
      }),
    ).toBeGreaterThan(0);

    await run({
      operationId: 'API-SPACE-DELETE',
      params: { spaceId: created.id },
      body: {
        version: created.version,
        expectedReferenceRevision: created.referenceRevision,
        referenceStrategy: 'block',
      },
    });
    expect(
      await models.KnowledgeResourcePermission.countDocuments({
        workspaceId,
        resourceType: 'space',
        resourceId: created.id,
        deletedAt: null,
      }),
    ).toBe(0);
    expect(
      await models.KnowledgeJob.countDocuments({
        workspaceId,
        kind: 'delete',
        resourceType: 'space',
        resourceId: created.id,
      }),
    ).toBe(1);
    expect(
      await models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateType: 'space',
        aggregateId: created.id,
        eventType: 'delete',
      }),
    ).toBe(1);
    expect(
      await models.KnowledgeAuditEvent.countDocuments({
        workspaceId,
        action: 'space.delete',
        resourceId: created.id,
      }),
    ).toBe(1);
  });

  it('L1-B01-KB-002-P01 persists folder hierarchy, type, path and creation model defaults', async () => {
    const root = await createSpace(`Parent folder ${suffix}`, {
      kind: 'folder',
      sourceAclMode: 'inherited',
    });
    const childFolder = await createSpace(`Child folder ${suffix}`, {
      kind: 'folder',
      parentSpaceId: root.id,
      sourceAclMode: 'inherited',
    });
    const child = await createSpace(`Child knowledge ${suffix}`, {
      parentSpaceId: childFolder.id,
    });
    expect(child.parentSpaceId).toBe(childFolder.id);
    expect(
      (await run({ operationId: 'API-SPACE-GET', params: { spaceId: child.id } })).data,
    ).toMatchObject({
      kind: 'space',
      parentSpaceId: childFolder.id,
      parentPath: [root.id, childFolder.id],
      modelBindings: {
        llm: expect.any(Object),
        embedding: expect.any(Object),
      },
    });
  });

  it('L1-B01-KB-002-N01 rejects missing parents and creation beyond the catalog depth', async () => {
    await expect(
      run({
        operationId: 'API-SPACE-CREATE',
        body: spaceBody(`Missing parent ${suffix}`, {
          kind: 'folder',
          parentSpaceId: new mongoose.Types.ObjectId().toString(),
        }),
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });

    let parentSpaceId: string | null = null;
    for (let depth = 0; depth < 6; depth += 1) {
      const folder = await createSpace(`Depth ${depth} ${suffix}`, {
        kind: 'folder',
        parentSpaceId,
        sourceAclMode: 'inherited',
      });
      parentSpaceId = folder.id;
    }
    const error = await run({
      operationId: 'API-SPACE-CREATE',
      body: spaceBody(`Depth overflow ${suffix}`, {
        kind: 'folder',
        parentSpaceId,
        sourceAclMode: 'inherited',
      }),
    }).catch((caught) => caught);
    expect(error).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });

  it('L1-B01-KB-003-P01 moves, batches, exports and transfers ownership with durable effects', async () => {
    const destination = await createSpace(`Destination ${suffix}`, {
      kind: 'folder',
      sourceAclMode: 'inherited',
    });
    const resource = await createSpace(`Move and transfer ${suffix}`);
    const moved = (
      await run({
        operationId: 'API-SPACE-MOVE',
        params: { spaceId: resource.id },
        body: { targetParentId: destination.id, version: resource.version },
      })
    ).data as { parentSpaceId: string; version: number };
    expect(moved).toMatchObject({
      parentSpaceId: destination.id,
      version: resource.version + 1,
    });

    const batchResource = await createSpace(`Batch ${suffix}`);
    const batch = (
      await run({
        operationId: 'API-SPACE-BATCH',
        body: {
          action: 'move',
          ids: [batchResource.id],
          targetParentId: destination.id,
          versions: { [batchResource.id]: batchResource.version },
        },
      })
    ).data as { succeeded: number; failed: number };
    expect(batch).toMatchObject({ succeeded: 1, failed: 0 });

    const exportJob = (
      await run({
        operationId: 'API-SPACE-EXPORT',
        params: { spaceId: resource.id },
        body: { format: 'zip' },
      })
    ).data as { jobId: string; status: string };
    expect(exportJob).toMatchObject({ status: 'queued' });
    expect(exportJob.jobId).toMatch(/^[a-f0-9]{24}$/);

    const targetMemberId = `${otherMemberId}_eligible`;
    await access.createCollaborator(
      resource.id,
      { memberId: targetMemberId, role: 'manage', version: moved.version },
      owner,
    );
    const current = (await run({ operationId: 'API-SPACE-GET', params: { spaceId: resource.id } }))
      .data as { version: number };
    const transferred = (
      await run({
        operationId: 'API-OWNERSHIP-TRANSFER',
        params: { spaceId: resource.id },
        body: { targetMemberId, version: current.version },
      })
    ).data as { ownershipMemberId: string; version: number };
    expect(transferred).toMatchObject({
      ownershipMemberId: targetMemberId,
      version: current.version + 1,
    });
    const acl = await access.getAcl('space', resource.id, {
      ...owner,
      memberId: targetMemberId,
    });
    expect(acl.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ principalId: targetMemberId, permission: 'owner' }),
      ]),
    );
    expect(acl.entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ principalId: memberId, permission: 'owner' }),
      ]),
    );
  });

  it('L1-B01-KB-003-N01 rejects an ineligible ownership target', async () => {
    const resource = await createSpace(`Invalid owner target ${suffix}`);
    const error = await run({
      operationId: 'API-OWNERSHIP-TRANSFER',
      params: { spaceId: resource.id },
      body: { targetMemberId: `not_a_member_${suffix}`, version: resource.version },
    }).catch((caught) => caught);
    expect(error).toMatchObject({
      problem: {
        error: { code: expect.stringMatching(/^KNOWLEDGE_(VALIDATION_FAILED|FORBIDDEN)$/) },
      },
    });
  });

  it('L1-B01-KB-003-A01 denies foreign moves and ownership transfers', async () => {
    const resource = await createSpace(`Foreign actions ${suffix}`);
    const destination = await createSpace(`Foreign destination ${suffix}`, {
      kind: 'folder',
      accessMode: 'workspace',
      sourceAclMode: 'inherited',
    });
    for (const operation of [
      {
        operationId: 'API-SPACE-MOVE',
        params: { spaceId: resource.id },
        body: { targetParentId: destination.id, version: resource.version },
      },
      {
        operationId: 'API-OWNERSHIP-TRANSFER',
        params: { spaceId: resource.id },
        body: { targetMemberId: `member_${suffix}`, version: resource.version },
      },
    ]) {
      await expect(run({ ...operation, context: foreign })).rejects.toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
      });
    }
  });

  it('L1-B01-KB-003-S01 blocks active references, requires latest revision and releases after remove', async () => {
    const resource = await createSpace(`Reference lifecycle ${suffix}`);
    const binding = await references.applyUpsert(
      {
        spaceId: resource.id,
        referrerType: 'workflow',
        referrerId: `workflow_${suffix}`,
        referrerVersion: 'v1',
        referrerName: 'B01 workflow',
        registryRevision: 1,
      },
      owner,
    );
    expect(binding.referenceRevision).toBe(1);
    const current = (await run({ operationId: 'API-SPACE-GET', params: { spaceId: resource.id } }))
      .data as { version: number; referenceRevision: number };
    await expect(
      run({
        operationId: 'API-SPACE-DELETE',
        params: { spaceId: resource.id },
        body: {
          version: current.version,
          expectedReferenceRevision: current.referenceRevision,
          referenceStrategy: 'block',
        },
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_REFERENCE_CONFLICT' } },
    });
    await references.applyRemove(
      {
        spaceId: resource.id,
        referrerType: 'workflow',
        referrerId: `workflow_${suffix}`,
        referrerVersion: 'v1',
        registryRevision: 2,
      },
      owner,
    );
    const released = (await run({ operationId: 'API-SPACE-GET', params: { spaceId: resource.id } }))
      .data as { version: number; referenceRevision: number };
    expect(released.referenceRevision).toBe(2);
    await expect(
      run({
        operationId: 'API-SPACE-DELETE',
        params: { spaceId: resource.id },
        body: {
          version: released.version,
          expectedReferenceRevision: 1,
          referenceStrategy: 'block',
        },
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    expect(
      (
        await run({
          operationId: 'API-SPACE-DELETE',
          params: { spaceId: resource.id },
          body: {
            version: released.version,
            expectedReferenceRevision: released.referenceRevision,
            referenceStrategy: 'block',
          },
        })
      ).status,
    ).toBe(202);
  });
});
