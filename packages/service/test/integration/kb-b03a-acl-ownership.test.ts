import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KnowledgeAccessRepository,
  KnowledgeApplication,
  KnowledgeAuditRepository,
  KnowledgeCatalogRepository,
  KnowledgeJobRepository,
  KnowledgeTagRepository,
  StaticKnowledgePrincipalDirectory,
} from '../../src/modules/knowledge';
import { createKnowledgeMongoConnection } from '../../src/shared/runtime/knowledge-connections';
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

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_b03a_ac_${suffix}`;
const traceId = suffix.padEnd(32, '0').slice(0, 32);

function actor(memberId: string, overrides: Partial<TenantContext> = {}): TenantContext {
  return {
    workspaceId,
    memberId,
    requestId: `req-${memberId}-${suffix}`,
    traceId,
    scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
    isWorkspaceOwner: false,
    ...overrides,
  };
}

const ownerContext = actor(`mem_owner_${suffix}`);
const managerContext = actor(`mem_manager_${suffix}`);
const editorContext = actor(`mem_editor_${suffix}`);
const viewerContext = actor(`mem_viewer_${suffix}`);
const outsiderContext = actor(`mem_outsider_${suffix}`);

type CreatedSpace = {
  id: string;
  version: number;
  ownershipMemberId: string;
};

type CreatedResource = {
  id: string;
  version: number;
  permissionRevision?: number;
  permissionState?: string;
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let catalog: KnowledgeCatalogRepository;
let access: KnowledgeAccessRepository;
let application: KnowledgeApplication;

async function run(
  operationId: string,
  input: {
    params?: Record<string, string>;
    query?: Record<string, string | string[] | undefined>;
    body?: unknown;
    context?: TenantContext;
  } = {},
) {
  return application.dispatch({
    operationId,
    params: input.params ?? {},
    query: input.query ?? {},
    body: input.body ?? {},
    context: input.context ?? ownerContext,
  });
}

async function createSpace(
  name: string,
  options: {
    sourcePermissionEnabled?: boolean;
    accessMode?: 'workspace' | 'restricted';
  } = {},
): Promise<CreatedSpace> {
  return (
    await run('API-SPACE-CREATE', {
      body: {
        kind: 'space',
        name,
        accessMode: options.accessMode ?? 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: options.sourcePermissionEnabled ?? true,
      },
    })
  ).data as CreatedSpace;
}

async function getSpace(spaceId: string): Promise<CreatedSpace & { permissionRevision: number }> {
  return (await run('API-SPACE-GET', { params: { spaceId } })).data as CreatedSpace & {
    permissionRevision: number;
  };
}

async function createDirectory(
  spaceId: string,
  name: string,
  parentDirectoryId: string | null = null,
): Promise<CreatedResource> {
  return (
    await run('API-DIRECTORY-CREATE', {
      params: { spaceId },
      body: { name, parentDirectoryId },
    })
  ).data as CreatedResource;
}

async function createSource(
  spaceId: string,
  name: string,
  directoryId: string | null = null,
  context = ownerContext,
): Promise<CreatedResource> {
  return (
    await run('API-SOURCE-CREATE', {
      params: { spaceId },
      body: { kind: 'text', name, directoryId },
      context,
    })
  ).data as CreatedResource;
}

function errorCode(error: unknown): unknown {
  return (error as { problem?: { error?: { code?: unknown } } }).problem?.error?.code;
}

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  access = new KnowledgeAccessRepository(
    connection,
    new StaticKnowledgePrincipalDirectory(
      [ownerContext, managerContext, editorContext, viewerContext].map((entry) => ({
        workspaceId: entry.workspaceId,
        memberId: entry.memberId,
      })),
    ),
  );
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
    await model.deleteMany({ workspaceId });
  }
});

afterAll(async () => {
  if (!connection) return;
  const models = registerKnowledgeModels(connection);
  for (const model of Object.values(models)) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('B03A ACL state and persistence', () => {
  it('L1-B03-COL-004-P01 persists enable, detach, ACL edit, resume and disable with explainable revisions', async () => {
    const space = await createSpace(`Lifecycle ${suffix}`);
    const source = await createSource(space.id, `Lifecycle source ${suffix}`);
    const models = registerKnowledgeModels(connection);
    const revisions: number[] = [Number(source.permissionRevision)];
    const snapshots: number[] = [];

    let acl = (
      await run('API-PERMISSION-ENABLE', {
        params: { sourceId: source.id },
        body: {
          version: source.version,
          expectedPermissionRevision: source.permissionRevision,
        },
      })
    ).data as {
      permissionState: string;
      permissionRevision: number;
      snapshotVersion: number;
      entries: Array<{ principalId: string }>;
    };
    expect(acl.permissionState).toBe('inherited');
    revisions.push(acl.permissionRevision);
    snapshots.push(acl.snapshotVersion);

    let currentSource = (await run('API-SOURCE-GET', { params: { sourceId: source.id } }))
      .data as CreatedResource;
    acl = (
      await run('API-PERMISSION-DETACH', {
        params: { sourceId: source.id },
        body: {
          version: currentSource.version,
          expectedPermissionRevision: currentSource.permissionRevision,
        },
      })
    ).data as typeof acl;
    expect(acl.permissionState).toBe('independent');
    revisions.push(acl.permissionRevision);
    snapshots.push(acl.snapshotVersion);

    currentSource = (await run('API-SOURCE-GET', { params: { sourceId: source.id } }))
      .data as CreatedResource;
    acl = (
      await run('API-ACL-UPDATE', {
        params: { resourceType: 'source', resourceId: source.id },
        body: {
          inheritMode: 'override',
          version: currentSource.version,
          entries: [
            {
              principalType: 'member',
              principalId: ownerContext.memberId,
              permission: 'owner',
            },
            {
              principalType: 'member',
              principalId: editorContext.memberId,
              permission: 'read',
            },
          ],
        },
      })
    ).data as typeof acl;
    expect(acl.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ principalId: ownerContext.memberId, permission: 'owner' }),
        expect.objectContaining({ principalId: editorContext.memberId, permission: 'read' }),
      ]),
    );
    revisions.push(acl.permissionRevision);
    snapshots.push(acl.snapshotVersion);

    currentSource = (await run('API-SOURCE-GET', { params: { sourceId: source.id } }))
      .data as CreatedResource;
    acl = (
      await run('API-PERMISSION-RESUME', {
        params: { sourceId: source.id },
        body: {
          version: currentSource.version,
          expectedPermissionRevision: currentSource.permissionRevision,
        },
      })
    ).data as typeof acl;
    expect(acl.permissionState).toBe('inherited');
    expect(acl.entries.some((entry) => entry.principalId === editorContext.memberId)).toBe(false);
    revisions.push(acl.permissionRevision);
    snapshots.push(acl.snapshotVersion);

    currentSource = (await run('API-SOURCE-GET', { params: { sourceId: source.id } }))
      .data as CreatedResource;
    acl = (
      await run('API-PERMISSION-DISABLE', {
        params: { sourceId: source.id },
        body: {
          version: currentSource.version,
          expectedPermissionRevision: currentSource.permissionRevision,
        },
      })
    ).data as typeof acl;
    expect(acl.permissionState).toBe('disabled');
    revisions.push(acl.permissionRevision);
    snapshots.push(acl.snapshotVersion);

    expect(revisions).toEqual([0, 1, 2, 3, 4, 5]);
    expect(snapshots).toEqual([...snapshots].sort((left, right) => left - right));
    expect(
      await models.KnowledgeAuditEvent.countDocuments({
        workspaceId,
        resourceId: source.id,
        action: { $in: ['acl.update', 'source.permission.enable', 'source.permission.detach'] },
      }),
    ).toBe(3);
    expect(
      await models.KnowledgeResourcePermission.countDocuments({
        workspaceId,
        resourceType: 'source',
        resourceId: source.id,
      }),
    ).toBe(0);
    expect(
      await run('API-ACL-GET', { params: { resourceType: 'source', resourceId: source.id } }),
    ).toMatchObject({ data: { permissionState: 'disabled' } });
  });

  it('L1-B03-COL-004-P02 supports Space and Directory get, override and resume', async () => {
    const space = await createSpace(`Generic ACL ${suffix}`);
    const currentSpace = (await run('API-SPACE-GET', { params: { spaceId: space.id } }))
      .data as CreatedSpace & { permissionRevision: number };
    const updatedSpace = (
      await run('API-ACL-UPDATE', {
        params: { resourceType: 'space', resourceId: space.id },
        body: {
          inheritMode: 'override',
          version: currentSpace.version,
          entries: [
            {
              principalType: 'member',
              principalId: ownerContext.memberId,
              permission: 'owner',
            },
            {
              principalType: 'member',
              principalId: editorContext.memberId,
              permission: 'read',
            },
          ],
        },
      })
    ).data as {
      permissionState: string;
      inheritMode: string;
      permissionRevision: number;
    };
    expect(updatedSpace).toMatchObject({
      permissionState: 'independent',
      inheritMode: 'override',
    });

    const directory = await createDirectory(space.id, `Directory ${suffix}`);
    const override = (
      await run('API-ACL-UPDATE', {
        params: { resourceType: 'directory', resourceId: directory.id },
        body: {
          inheritMode: 'override',
          version: directory.version,
          entries: [
            {
              principalType: 'member',
              principalId: ownerContext.memberId,
              permission: 'owner',
            },
            {
              principalType: 'member',
              principalId: viewerContext.memberId,
              permission: 'read',
            },
          ],
        },
      })
    ).data as { permissionState: string; permissionRevision: number };
    expect(override.permissionState).toBe('independent');

    const currentDirectory = (
      await run('API-DIRECTORY-GET', { params: { directoryId: directory.id } })
    ).data as CreatedResource;
    const resumed = (
      await run('API-ACL-RESUME', {
        params: { resourceType: 'directory', resourceId: directory.id },
        body: { version: currentDirectory.version },
      })
    ).data as { permissionState: string; entries: unknown[] };
    expect(resumed).toMatchObject({ permissionState: 'inherited' });
    expect(resumed.entries).not.toContainEqual(
      expect.objectContaining({ principalId: viewerContext.memberId }),
    );
  });

  it('L1-B03-COL-004-N01 rejects stale revisions, illegal transitions and edits while Source permission is disabled', async () => {
    const space = await createSpace(`Conflicts ${suffix}`);
    const source = await createSource(space.id, `Conflict source ${suffix}`);
    const enabled = (
      await run('API-PERMISSION-ENABLE', {
        params: { sourceId: source.id },
        body: {
          version: source.version,
          expectedPermissionRevision: source.permissionRevision,
        },
      })
    ).data as { permissionRevision: number };
    const currentSource = (await run('API-SOURCE-GET', { params: { sourceId: source.id } }))
      .data as CreatedResource;

    await expect(
      run('API-PERMISSION-ENABLE', {
        params: { sourceId: source.id },
        body: {
          version: currentSource.version,
          expectedPermissionRevision: enabled.permissionRevision - 1,
        },
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });

    await expect(
      run('API-PERMISSION-RESUME', {
        params: { sourceId: source.id },
        body: {
          version: currentSource.version,
          expectedPermissionRevision: currentSource.permissionRevision,
        },
      }),
    ).resolves.toMatchObject({ data: { permissionState: 'inherited' } });

    const disabledSource = await createSource(space.id, `Disabled source ${suffix}`);
    const models = registerKnowledgeModels(connection);
    const before = await models.KnowledgeResourcePermission.countDocuments({
      workspaceId,
      resourceType: 'source',
      resourceId: disabledSource.id,
    });
    await expect(
      run('API-ACL-UPDATE', {
        params: { resourceType: 'source', resourceId: disabledSource.id },
        body: {
          inheritMode: 'override',
          version: disabledSource.version,
          entries: [
            {
              principalType: 'member',
              principalId: editorContext.memberId,
              permission: 'read',
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
    expect(
      await models.KnowledgeResourcePermission.countDocuments({
        workspaceId,
        resourceType: 'source',
        resourceId: disabledSource.id,
      }),
    ).toBe(before);
  });

  it('L1-B03-COL-004-N02 rejects invalid roles, resource types and stale ACL versions without partial ACL rows', async () => {
    const space = await createSpace(`Validation ${suffix}`);
    const models = registerKnowledgeModels(connection);
    const before = await models.KnowledgeResourcePermission.countDocuments({
      workspaceId,
      resourceType: 'space',
      resourceId: space.id,
    });

    const invalidRole = await run('API-ACL-UPDATE', {
      params: { resourceType: 'space', resourceId: space.id },
      body: {
        inheritMode: 'override',
        version: space.version,
        entries: [
          {
            principalType: 'member',
            principalId: editorContext.memberId,
            permission: 'administrator',
          },
        ],
      },
    }).catch((error) => error);
    expect(errorCode(invalidRole)).toBe('KNOWLEDGE_VALIDATION_FAILED');

    await expect(
      run('API-ACL-GET', {
        params: { resourceType: 'segment', resourceId: space.id },
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } } });

    await expect(
      run('API-ACL-UPDATE', {
        params: { resourceType: 'space', resourceId: space.id },
        body: {
          inheritMode: 'override',
          version: space.version + 1,
          entries: [],
        },
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });

    expect(
      await models.KnowledgeResourcePermission.countDocuments({
        workspaceId,
        resourceType: 'space',
        resourceId: space.id,
      }),
    ).toBe(before);
  });

  it('L1-B03-COL-004-N03 blocks Source ACL work while the Space Source-permission switch is off', async () => {
    const space = await createSpace(`Master switch ${suffix}`, { sourcePermissionEnabled: false });
    const source = await createSource(space.id, `Master switch source ${suffix}`);
    await expect(
      run('API-PERMISSION-ENABLE', {
        params: { sourceId: source.id },
        body: {
          version: source.version,
          expectedPermissionRevision: source.permissionRevision,
        },
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
    const models = registerKnowledgeModels(connection);
    const persisted = await models.KnowledgeSource.findOne({
      workspaceId,
      _id: source.id,
    }).lean();
    expect(persisted).toMatchObject({
      permissionState: 'disabled',
      permissionRevision: 0,
    });
  });

  it('L1-B03-COL-004-N04 rejects resume when the root resource has no inheritable parent', async () => {
    const space = await createSpace(`Root resume ${suffix}`);
    await expect(
      run('API-ACL-RESUME', {
        params: { resourceType: 'space', resourceId: space.id },
        body: { version: space.version },
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
  });

  it('L1-B03-COL-004-F01 rolls back ACL rows when the audit write fails', async () => {
    const space = await createSpace(`Fault rollback ${suffix}`);
    const models = registerKnowledgeModels(connection);
    const before = await models.KnowledgeResourcePermission.find({
      workspaceId,
      resourceType: 'space',
      resourceId: space.id,
      deletedAt: null,
    })
      .sort({ principalId: 1 })
      .lean();
    const spy = vi
      .spyOn(models.KnowledgeAuditEvent, 'create')
      .mockRejectedValueOnce(new Error('injected audit failure'));
    try {
      await expect(
        run('API-ACL-UPDATE', {
          params: { resourceType: 'space', resourceId: space.id },
          body: {
            inheritMode: 'override',
            version: space.version,
            entries: [
              {
                principalType: 'member',
                principalId: ownerContext.memberId,
                permission: 'owner',
              },
              {
                principalType: 'member',
                principalId: editorContext.memberId,
                permission: 'read',
              },
            ],
          },
        }),
      ).rejects.toThrow('injected audit failure');
    } finally {
      spy.mockRestore();
    }
    const after = await models.KnowledgeResourcePermission.find({
      workspaceId,
      resourceType: 'space',
      resourceId: space.id,
      deletedAt: null,
    })
      .sort({ principalId: 1 })
      .lean();
    expect(after).toEqual(before);
  });

  it('L1-B03-COL-004-F02 makes repeated resume idempotent after the first legal resume', async () => {
    const space = await createSpace(`Resume idempotency ${suffix}`);
    const source = await createSource(space.id, `Resume source ${suffix}`);
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
    const current = (await run('API-SOURCE-GET', { params: { sourceId: source.id } })).data as {
      version: number;
      permissionRevision: number;
    };
    const first = await run('API-PERMISSION-RESUME', {
      params: { sourceId: source.id },
      body: {
        version: current.version,
        expectedPermissionRevision: current.permissionRevision,
      },
    });
    expect(first).toMatchObject({ data: { permissionState: 'inherited' } });
    expect(detached.permissionRevision).toBe(enabled.permissionRevision + 1);
    const inherited = (await run('API-SOURCE-GET', { params: { sourceId: source.id } })).data as {
      version: number;
      permissionRevision: number;
    };
    await expect(
      run('API-PERMISSION-RESUME', {
        params: { sourceId: source.id },
        body: {
          version: inherited.version,
          expectedPermissionRevision: inherited.permissionRevision,
        },
      }),
    ).resolves.toMatchObject({ data: { permissionState: 'inherited' } });
  });
});

describe('B03A roles, inheritance and collaborator support', () => {
  it('L1-B03-AUTH-002-P01 enforces owner, manage, write, read and non-member actions', async () => {
    const space = await createSpace(`Role matrix ${suffix}`, { accessMode: 'restricted' });
    await access.createCollaborator(
      space.id,
      { memberId: managerContext.memberId, role: 'manage' },
      ownerContext,
    );
    await access.createCollaborator(
      space.id,
      { memberId: editorContext.memberId, role: 'write' },
      ownerContext,
    );
    await access.createCollaborator(
      space.id,
      { memberId: viewerContext.memberId, role: 'read' },
      ownerContext,
    );

    const managed = await createSource(space.id, `Managed source ${suffix}`, null, managerContext);
    const edited = await createSource(space.id, `Edited source ${suffix}`, null, editorContext);
    expect(managed.id).toMatch(/^[a-f0-9]{24}$/);
    expect(edited.id).toMatch(/^[a-f0-9]{24}$/);
    expect(
      await run('API-SOURCE-GET', {
        params: { sourceId: edited.id },
        context: viewerContext,
      }),
    ).toMatchObject({ data: { id: edited.id } });

    await expect(
      run('API-SOURCE-CREATE', {
        params: { spaceId: space.id },
        body: { kind: 'text', name: `Viewer write ${suffix}` },
        context: viewerContext,
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    await expect(
      run('API-ACL-UPDATE', {
        params: { resourceType: 'space', resourceId: space.id },
        body: { inheritMode: 'override', version: space.version, entries: [] },
        context: editorContext,
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    await expect(
      run('API-SPACE-GET', {
        params: { spaceId: space.id },
        context: outsiderContext,
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
  });

  it('L1-B03-AUTH-002-P02 inherits the nearest Directory override for a nested Source', async () => {
    const space = await createSpace(`Nested inherit ${suffix}`);
    const parent = await createDirectory(space.id, `Parent ${suffix}`);
    const child = await createDirectory(space.id, `Child ${suffix}`, parent.id);
    await run('API-ACL-UPDATE', {
      params: { resourceType: 'directory', resourceId: parent.id },
      body: {
        inheritMode: 'override',
        version: parent.version,
        entries: [
          {
            principalType: 'member',
            principalId: ownerContext.memberId,
            permission: 'owner',
          },
          {
            principalType: 'member',
            principalId: editorContext.memberId,
            permission: 'read',
          },
        ],
      },
    });
    const source = await createSource(space.id, `Nested source ${suffix}`, child.id);
    expect(
      await run('API-SOURCE-GET', {
        params: { sourceId: source.id },
        context: editorContext,
      }),
    ).toMatchObject({ data: { id: source.id } });
  });

  it('L1-B03-AUTH-002-A01 hides collaborator membership from readers and revokes immediately', async () => {
    const space = await createSpace(`Collaborator visibility ${suffix}`, {
      accessMode: 'restricted',
    });
    const collaborator = await access.createCollaborator(
      space.id,
      { memberId: viewerContext.memberId, role: 'read' },
      ownerContext,
    );
    await expect(access.listCollaborators(space.id, viewerContext)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    await access.deleteCollaborator(space.id, viewerContext.memberId, ownerContext);
    await expect(
      run('API-SPACE-GET', {
        params: { spaceId: space.id },
        context: viewerContext,
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    expect(collaborator.version).toBe(1);
  });

  it('L1-B03-AUTH-002-S01 atomically updates collaborator role, ACL, revision and audit', async () => {
    const space = await createSpace(`Collaborator update ${suffix}`);
    const collaborator = await access.createCollaborator(
      space.id,
      { memberId: editorContext.memberId, role: 'read' },
      ownerContext,
    );
    const before = await run('API-ACL-GET', {
      params: { resourceType: 'space', resourceId: space.id },
    });
    const updated = await access.updateCollaborator(
      space.id,
      editorContext.memberId,
      { role: 'write', version: collaborator.version },
      ownerContext,
    );
    const after = await run('API-ACL-GET', {
      params: { resourceType: 'space', resourceId: space.id },
    });
    expect(updated).toMatchObject({ memberId: editorContext.memberId, role: 'write', version: 2 });
    expect(after.data.permissionRevision).toBe(before.data.permissionRevision + 1);
    expect(after.data.snapshotVersion).toBeGreaterThan(before.data.snapshotVersion);
    expect(
      await run('API-SOURCE-CREATE', {
        params: { spaceId: space.id },
        body: { kind: 'text', name: `Updated collaborator ${suffix}` },
        context: editorContext,
      }),
    ).toMatchObject({ status: 201 });
  });

  it('L1-B03-AUTH-002-N01 rejects a duplicate collaborator with a stable conflict error', async () => {
    const space = await createSpace(`Duplicate collaborator ${suffix}`);
    const first = await access.createCollaborator(
      space.id,
      { memberId: viewerContext.memberId, role: 'read' },
      ownerContext,
    );
    await expect(
      access.createCollaborator(
        space.id,
        { memberId: viewerContext.memberId, role: 'write' },
        ownerContext,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
    expect(first.version).toBe(1);
  });

  it('L1-B03-AUTH-002-N02 allows a revoked collaborator to be added again without duplicate ACL', async () => {
    const space = await createSpace(`Revoked collaborator ${suffix}`);
    await access.createCollaborator(
      space.id,
      { memberId: viewerContext.memberId, role: 'read' },
      ownerContext,
    );
    await access.deleteCollaborator(space.id, viewerContext.memberId, ownerContext);
    await expect(
      access.createCollaborator(
        space.id,
        { memberId: viewerContext.memberId, role: 'read' },
        ownerContext,
      ),
    ).resolves.toMatchObject({ memberId: viewerContext.memberId, status: 'active' });
    const models = registerKnowledgeModels(connection);
    expect(
      await models.KnowledgeResourcePermission.countDocuments({
        workspaceId,
        resourceType: 'space',
        resourceId: space.id,
        principalType: 'member',
        principalId: viewerContext.memberId,
        deletedAt: null,
      }),
    ).toBe(1);
  });

  it('L1-B03-AUTH-003-N04 rejects an unknown Workspace member before writing collaborator or ACL rows', async () => {
    const space = await createSpace(`Unknown principal ${suffix}`);
    const unknownMemberId = `mem_unknown_${suffix}`;
    const models = registerKnowledgeModels(connection);
    const before = {
      collaborators: await models.KnowledgeCollaborator.countDocuments({
        workspaceId,
        knowledgeSpaceId: space.id,
      }),
      permissions: await models.KnowledgeResourcePermission.countDocuments({
        workspaceId,
        knowledgeSpaceId: space.id,
      }),
    };
    await expect(
      access.createCollaborator(
        space.id,
        { memberId: unknownMemberId, role: 'read' },
        ownerContext,
      ),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          details: { field: 'memberId', reason: 'member_not_eligible' },
        },
      },
    });
    expect({
      collaborators: await models.KnowledgeCollaborator.countDocuments({
        workspaceId,
        knowledgeSpaceId: space.id,
      }),
      permissions: await models.KnowledgeResourcePermission.countDocuments({
        workspaceId,
        knowledgeSpaceId: space.id,
      }),
    }).toEqual(before);
  });
});

describe('B03A ownership transfer', () => {
  it('L1-B03-AUTH-004-P01 transfers to a qualified manager and leaves exactly one owner', async () => {
    const space = await createSpace(`Transfer ${suffix}`);
    await access.createCollaborator(
      space.id,
      { memberId: managerContext.memberId, role: 'manage' },
      ownerContext,
    );
    const currentSpace = await getSpace(space.id);
    const transferred = (
      await run('API-OWNERSHIP-TRANSFER', {
        params: { spaceId: space.id },
        body: { targetMemberId: managerContext.memberId, version: currentSpace.version },
      })
    ).data as CreatedSpace;
    expect(transferred.ownershipMemberId).toBe(managerContext.memberId);
    const acl = await access.getAcl('space', space.id, managerContext);
    expect(acl.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principalId: managerContext.memberId,
          permission: 'owner',
        }),
      ]),
    );
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
    expect(
      await models.KnowledgeAuditEvent.countDocuments({
        workspaceId,
        resourceId: space.id,
        action: 'ownership.transfer',
      }),
    ).toBe(1);
    await expect(
      run('API-OWNERSHIP-TRANSFER', {
        params: { spaceId: space.id },
        body: { targetMemberId: ownerContext.memberId, version: transferred.version },
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
  });

  it('L1-B03-AUTH-004-N01 rejects a read-only ownership target', async () => {
    const readSpace = await createSpace(`Read target ${suffix}`);
    await access.createCollaborator(
      readSpace.id,
      { memberId: viewerContext.memberId, role: 'read' },
      ownerContext,
    );
    const currentReadSpace = await getSpace(readSpace.id);
    await expect(
      run('API-OWNERSHIP-TRANSFER', {
        params: { spaceId: readSpace.id },
        body: { targetMemberId: viewerContext.memberId, version: currentReadSpace.version },
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } } });
  });

  it('L1-B03-AUTH-004-N02 rejects transferring ownership to the current owner', async () => {
    const selfSpace = await createSpace(`Self target ${suffix}`);
    await expect(
      run('API-OWNERSHIP-TRANSFER', {
        params: { spaceId: selfSpace.id },
        body: { targetMemberId: ownerContext.memberId, version: selfSpace.version },
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } } });
  });

  it('L1-B03-AUTH-004-S01 propagates transferred ownership to descendant Directory and Source records', async () => {
    const space = await createSpace(`Descendant ownership ${suffix}`);
    const directory = await createDirectory(space.id, `Owned directory ${suffix}`);
    const source = await createSource(space.id, `Owned source ${suffix}`, directory.id);
    await access.createCollaborator(
      space.id,
      { memberId: managerContext.memberId, role: 'manage' },
      ownerContext,
    );
    const currentSpace = await getSpace(space.id);
    await run('API-OWNERSHIP-TRANSFER', {
      params: { spaceId: space.id },
      body: { targetMemberId: managerContext.memberId, version: currentSpace.version },
    });
    const models = registerKnowledgeModels(connection);
    expect(
      await models.KnowledgeDirectory.findOne({
        workspaceId,
        _id: directory.id,
      }).lean(),
    ).toMatchObject({ ownershipMemberId: managerContext.memberId });
    expect(
      await models.KnowledgeSource.findOne({
        workspaceId,
        _id: source.id,
      }).lean(),
    ).toMatchObject({ ownershipMemberId: managerContext.memberId });
  });

  it('L1-B03-AUTH-004-S02 writes a replayable ownership Outbox fact in the transfer transaction', async () => {
    const space = await createSpace(`Ownership outbox ${suffix}`);
    await access.createCollaborator(
      space.id,
      { memberId: managerContext.memberId, role: 'manage' },
      ownerContext,
    );
    const currentSpace = await getSpace(space.id);
    await run('API-OWNERSHIP-TRANSFER', {
      params: { spaceId: space.id },
      body: { targetMemberId: managerContext.memberId, version: currentSpace.version },
    });
    const models = registerKnowledgeModels(connection);
    const facts = await models.KnowledgeOutboxEvent.find({
      workspaceId,
      aggregateId: space.id,
      eventType: /permission|acl|ownership/i,
    }).lean();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('L1-B03-AUTH-004-F01 rolls back ownership and owner ACL when audit persistence fails', async () => {
    const space = await createSpace(`Transfer rollback ${suffix}`);
    await access.createCollaborator(
      space.id,
      { memberId: managerContext.memberId, role: 'manage' },
      ownerContext,
    );
    const currentSpace = await getSpace(space.id);
    const models = registerKnowledgeModels(connection);
    const spy = vi
      .spyOn(models.KnowledgeAuditEvent, 'create')
      .mockRejectedValueOnce(new Error('injected ownership audit failure'));
    try {
      await expect(
        run('API-OWNERSHIP-TRANSFER', {
          params: { spaceId: space.id },
          body: { targetMemberId: managerContext.memberId, version: currentSpace.version },
        }),
      ).rejects.toThrow('injected ownership audit failure');
    } finally {
      spy.mockRestore();
    }
    expect((await run('API-SPACE-GET', { params: { spaceId: space.id } })).data).toMatchObject({
      ownershipMemberId: ownerContext.memberId,
      version: currentSpace.version,
    });
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
});
