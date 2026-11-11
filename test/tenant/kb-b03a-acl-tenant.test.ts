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
const workspaceA = `ws_b03a_tenant_a_${suffix}`;
const workspaceB = `ws_b03a_tenant_b_${suffix}`;
const traceId = suffix.padEnd(32, '0').slice(0, 32);

function context(workspaceId: string, memberId = `mem_owner_${suffix}`): TenantContext {
  return {
    workspaceId,
    memberId,
    requestId: `req_${workspaceId}_${memberId}`,
    traceId,
    scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
    isWorkspaceOwner: false,
  };
}

const ownerA = context(workspaceA);
const ownerB = context(workspaceB, `mem_owner_b_${suffix}`);

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
  },
) {
  return application.dispatch({
    operationId,
    params: input.params ?? {},
    query: {},
    body: input.body ?? {},
    context: input.context ?? ownerA,
  });
}

async function seed() {
  const space = (
    await run('API-SPACE-CREATE', {
      body: {
        kind: 'space',
        name: `Tenant ACL ${suffix}`,
        accessMode: 'restricted',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
    })
  ).data as { id: string; version: number };
  const directory = (
    await run('API-DIRECTORY-CREATE', {
      params: { spaceId: space.id },
      body: { name: `Tenant directory ${suffix}`, parentDirectoryId: null },
    })
  ).data as { id: string; version: number };
  const source = (
    await run('API-SOURCE-CREATE', {
      params: { spaceId: space.id },
      body: {
        kind: 'text',
        name: `Tenant source ${suffix}`,
        directoryId: directory.id,
      },
    })
  ).data as { id: string; version: number; permissionRevision: number };
  const enabled = (
    await run('API-PERMISSION-ENABLE', {
      params: { sourceId: source.id },
      body: {
        version: source.version,
        expectedPermissionRevision: source.permissionRevision,
      },
    })
  ).data as { permissionRevision: number };
  const detached = (
    await run('API-PERMISSION-DETACH', {
      params: { sourceId: source.id },
      body: {
        version: source.version + 1,
        expectedPermissionRevision: enabled.permissionRevision,
      },
    })
  ).data as { permissionRevision: number };
  const currentSource = (await run('API-SOURCE-GET', { params: { sourceId: source.id } })).data as {
    id: string;
    version: number;
    permissionRevision: number;
  };
  return { space, directory, source: currentSource, detached };
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
  for (const model of Object.values(models)) {
    await model.deleteMany({ workspaceId: { $in: [workspaceA, workspaceB] } });
  }
});

afterAll(async () => {
  if (!connection) return;
  const models = registerKnowledgeModels(connection);
  for (const model of Object.values(models)) {
    await model.deleteMany({ workspaceId: { $in: [workspaceA, workspaceB] } });
  }
  await connection.close();
});

describe('B03A ACL tenant guard', () => {
  it('L1-B03-COL-004-A01 denies cross-workspace ACL get, update, resume and ownership transfer', async () => {
    const fixture = await seed();
    const models = registerKnowledgeModels(connection);
    const sourceBefore = await models.KnowledgeSource.findById(fixture.source.id).lean();
    const aclBefore = await models.KnowledgeResourcePermission.find({
      resourceType: 'source',
      resourceId: fixture.source.id,
    })
      .sort({ principalId: 1 })
      .lean();

    await expect(
      run('API-ACL-GET', {
        params: { resourceType: 'source', resourceId: fixture.source.id },
        context: ownerB,
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    await expect(
      run('API-ACL-UPDATE', {
        params: { resourceType: 'source', resourceId: fixture.source.id },
        body: {
          inheritMode: 'override',
          version: fixture.source.version,
          entries: [],
        },
        context: ownerB,
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    await expect(
      run('API-ACL-RESUME', {
        params: { resourceType: 'source', resourceId: fixture.source.id },
        body: { version: fixture.source.version },
        context: ownerB,
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    await expect(
      run('API-RESOURCE-OWNERSHIP-TRANSFER', {
        params: { resourceType: 'source', resourceId: fixture.source.id },
        body: {
          targetMemberId: ownerB.memberId,
          version: fixture.source.version,
        },
        context: ownerB,
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });

    expect(await models.KnowledgeSource.findById(fixture.source.id).lean()).toEqual(sourceBefore);
    expect(
      await models.KnowledgeResourcePermission.find({
        resourceType: 'source',
        resourceId: fixture.source.id,
      })
        .sort({ principalId: 1 })
        .lean(),
    ).toEqual(aclBefore);
  });

  it('L1-B03-COL-004-A02 rejects cross-workspace children and does not reveal parent or names', async () => {
    const fixture = await seed();
    const crossDirectory = await run('API-DIRECTORY-GET', {
      params: { directoryId: fixture.directory.id },
      context: ownerB,
    }).catch((error) => error);
    expect(crossDirectory).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    const serialized = JSON.stringify(crossDirectory, Object.getOwnPropertyNames(crossDirectory));
    expect(serialized).not.toContain(`Tenant directory ${suffix}`);
    expect(serialized).not.toContain(fixture.space.id);
  });

  it('L1-B03-AUTH-002-A01 rejects missing workspace without an unfiltered fallback', async () => {
    await seed();
    await expect(
      run('API-SPACE-LIST', {
        context: { ...ownerA, workspaceId: '   ' },
      }),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          details: { field: 'workspaceId' },
        },
      },
    });
  });
});
