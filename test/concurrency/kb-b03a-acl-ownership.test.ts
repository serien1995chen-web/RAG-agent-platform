import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KnowledgeAccessRepository,
  KnowledgeApplication,
  KnowledgeAuditRepository,
  KnowledgeCatalogRepository,
  KnowledgeJobRepository,
  KnowledgeTagRepository,
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
const workspaceId = `ws_b03a_cas_${suffix}`;
const traceId = suffix.padEnd(32, '0').slice(0, 32);
const ownerContext: TenantContext = {
  workspaceId,
  memberId: `mem_owner_${suffix}`,
  requestId: `req_owner_${suffix}`,
  traceId,
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: false,
};
const workspaceAdminContext: TenantContext = {
  ...ownerContext,
  memberId: `mem_admin_${suffix}`,
  requestId: `req_admin_${suffix}`,
  isWorkspaceOwner: true,
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let catalog: KnowledgeCatalogRepository;
let access: KnowledgeAccessRepository;
let application: KnowledgeApplication;

async function run(
  operationId: string,
  input: {
    params?: Record<string, string>;
    body?: unknown;
    context?: TenantContext;
  } = {},
) {
  return application.dispatch({
    operationId,
    params: input.params ?? {},
    query: {},
    body: input.body ?? {},
    context: input.context ?? ownerContext,
  });
}

async function createSpace(name: string) {
  return (
    await run('API-SPACE-CREATE', {
      body: {
        kind: 'space',
        name,
        accessMode: 'restricted',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
    })
  ).data as { id: string; version: number; ownershipMemberId: string };
}

async function createSource(spaceId: string, name: string) {
  return (
    await run('API-SOURCE-CREATE', {
      params: { spaceId },
      body: { kind: 'text', name },
    })
  ).data as { id: string; version: number; permissionRevision: number };
}

function ownerEntry() {
  return {
    principalType: 'member' as const,
    principalId: ownerContext.memberId,
    permission: 'owner' as const,
  };
}

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  access = new KnowledgeAccessRepository(connection);
  application = new KnowledgeApplication(
    catalog,
    new KnowledgeTagRepository(connection),
    access,
    new KnowledgeJobRepository(connection),
    undefined,
    undefined,
    undefined,
    new KnowledgeAuditRepository(connection),
  );
}, 60_000);

beforeEach(async () => {
  const models = registerKnowledgeModels(connection);
  for (const model of Object.values(models)) await model.deleteMany({ workspaceId });
});

afterAll(async () => {
  if (!connection) return;
  const models = registerKnowledgeModels(connection);
  for (const model of Object.values(models)) await model.deleteMany({ workspaceId });
  await connection.close();
});

describe('B03A ACL and ownership concurrency', () => {
  it('L1-B03-COL-004-C01 allows exactly one same-version ACL update', async () => {
    const space = await createSpace(`ACL CAS ${suffix}`);
    const update = (memberId: string) =>
      run('API-ACL-UPDATE', {
        params: { resourceType: 'space', resourceId: space.id },
        body: {
          inheritMode: 'override',
          version: space.version,
          entries: [
            ownerEntry(),
            {
              principalType: 'member',
              principalId: memberId,
              permission: 'read',
            },
          ],
        },
      });
    const results = await Promise.allSettled([
      update(`member_a_${suffix}`),
      update(`member_b_${suffix}`),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } },
    });
    const models = registerKnowledgeModels(connection);
    expect(
      await models.KnowledgeResourcePermission.countDocuments({
        workspaceId,
        resourceType: 'space',
        resourceId: space.id,
        permission: 'owner',
        deletedAt: null,
      }),
    ).toBe(1);
  });

  it('L1-B03-COL-004-C02 rejects stale permission revisions', async () => {
    const space = await createSpace(`Permission CAS ${suffix}`);
    const source = await createSource(space.id, `Permission source ${suffix}`);
    const enabled = (
      await run('API-PERMISSION-ENABLE', {
        params: { sourceId: source.id },
        body: {
          version: source.version,
          expectedPermissionRevision: source.permissionRevision,
        },
      })
    ).data as { permissionRevision: number };
    await expect(
      run('API-PERMISSION-DETACH', {
        params: { sourceId: source.id },
        body: {
          version: source.version + 1,
          expectedPermissionRevision: enabled.permissionRevision - 1,
        },
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
  });

  it('L1-B03-COL-004-C03 permits only one of concurrent detach and disable', async () => {
    const space = await createSpace(`Transition race ${suffix}`);
    const source = await createSource(space.id, `Transition race source ${suffix}`);
    const enabled = (
      await run('API-PERMISSION-ENABLE', {
        params: { sourceId: source.id },
        body: {
          version: source.version,
          expectedPermissionRevision: source.permissionRevision,
        },
      })
    ).data as { permissionRevision: number };
    const current = (await run('API-SOURCE-GET', { params: { sourceId: source.id } })).data as {
      version: number;
      permissionRevision: number;
    };
    const body = {
      version: current.version,
      expectedPermissionRevision: current.permissionRevision,
    };
    const results = await Promise.allSettled([
      run('API-PERMISSION-DETACH', { params: { sourceId: source.id }, body }),
      run('API-PERMISSION-DISABLE', { params: { sourceId: source.id }, body }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      (await run('API-SOURCE-GET', { params: { sourceId: source.id } })).data.permissionRevision,
    ).toBe(enabled.permissionRevision + 1);
  });

  it('L1-B03-AUTH-004-C01 allows exactly one same-version ownership transfer', async () => {
    const space = await createSpace(`Ownership race ${suffix}`);
    const targetA = `member_target_a_${suffix}`;
    const targetB = `member_target_b_${suffix}`;
    for (const memberId of [targetA, targetB]) {
      await access.createCollaborator(space.id, { memberId, role: 'manage' }, ownerContext);
    }
    const currentSpace = (await run('API-SPACE-GET', { params: { spaceId: space.id } })).data as {
      version: number;
    };
    const transfer = (targetMemberId: string) =>
      run('API-OWNERSHIP-TRANSFER', {
        params: { spaceId: space.id },
        body: { targetMemberId, version: currentSpace.version },
      });
    const results = await Promise.allSettled([transfer(targetA), transfer(targetB)]);
    const statuses = results.map((result) =>
      result.status === 'fulfilled'
        ? 'fulfilled'
        : `rejected:${String((result.reason as { problem?: { error?: { code?: string } } }).problem?.error?.code)}`,
    );
    expect(statuses).toEqual(expect.arrayContaining(['fulfilled']));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } },
    });
    const models = registerKnowledgeModels(connection);
    expect(
      await models.KnowledgeResourcePermission.countDocuments({
        workspaceId,
        resourceType: 'space',
        resourceId: space.id,
        permission: 'owner',
        deletedAt: null,
      }),
    ).toBe(1);
  });

  it('L1-B03-AUTH-004-C02 permits only one of ownership transfer and ACL update at the same version', async () => {
    const space = await createSpace(`Transfer ACL race ${suffix}`);
    const target = `member_transfer_target_${suffix}`;
    await access.createCollaborator(space.id, { memberId: target, role: 'manage' }, ownerContext);
    const currentSpace = (await run('API-SPACE-GET', { params: { spaceId: space.id } })).data as {
      version: number;
    };
    const results = await Promise.allSettled([
      run('API-OWNERSHIP-TRANSFER', {
        params: { spaceId: space.id },
        body: { targetMemberId: target, version: currentSpace.version },
      }),
      run('API-ACL-UPDATE', {
        params: { resourceType: 'space', resourceId: space.id },
        body: {
          inheritMode: 'override',
          version: currentSpace.version,
          entries: [ownerEntry()],
        },
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const finalSpace = (
      await run('API-SPACE-GET', {
        params: { spaceId: space.id },
        // Ownership transfer intentionally removes the original owner's access.
        context: workspaceAdminContext,
      })
    ).data;
    expect(finalSpace.version).toBe(currentSpace.version + 1);
  });
});
