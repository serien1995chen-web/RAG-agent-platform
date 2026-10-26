import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KnowledgeAccessRepository,
  KnowledgeApplication,
  KnowledgeAuditRepository,
  KnowledgeCatalogRepository,
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
const workspaceId = `ws_cas_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `member_${suffix}`,
  requestId: `req_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
  isWorkspaceOwner: true,
};
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let repository: KnowledgeCatalogRepository;
let application: KnowledgeApplication;

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  await ensureKnowledgeCollections(connection);
  repository = new KnowledgeCatalogRepository(connection);
  application = new KnowledgeApplication(
    repository,
    {} as never,
    new KnowledgeAccessRepository(connection),
    {} as never,
    undefined,
    undefined,
    undefined,
    new KnowledgeAuditRepository(connection),
  );
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  const models = registerKnowledgeModels(connection);
  for (const model of Object.values(models)) await model.deleteMany({ workspaceId });
  await connection.close();
});

describe('Mongo CAS concurrency', () => {
  it('allows one same-version update and returns conflict for every stale writer', async () => {
    const space = await repository.createSpace(
      {
        kind: 'space',
        name: `CAS ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context,
    );
    const outcomes = await Promise.allSettled([
      repository.updateSpace(space.id, { version: space.version, name: 'A' }, context),
      repository.updateSpace(space.id, { version: space.version, name: 'B' }, context),
      repository.updateSpace(space.id, { version: space.version, name: 'C' }, context),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(2);
  });

  it('allows exactly one same-version move', async () => {
    const folderA = await repository.createSpace(
      {
        kind: 'folder',
        name: `Move A ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'inherited',
        sourcePermissionEnabled: true,
      },
      context,
    );
    const folderB = await repository.createSpace(
      {
        kind: 'folder',
        name: `Move B ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'inherited',
        sourcePermissionEnabled: true,
      },
      context,
    );
    const resource = await repository.createSpace(
      {
        kind: 'space',
        name: `Move Resource ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context,
    );
    const outcomes = await Promise.allSettled([
      repository.moveSpace(
        resource.id,
        { targetParentId: folderA.id, version: resource.version },
        context,
      ),
      repository.moveSpace(
        resource.id,
        { targetParentId: folderB.id, version: resource.version },
        context,
      ),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('allows exactly one same-version Directory subtree move', async () => {
    const space = await repository.createSpace(
      {
        kind: 'space',
        name: `Directory CAS ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context,
    );
    const parent = await repository.createDirectory(
      space.id,
      { name: `Directory source ${suffix}` },
      context,
    );
    const child = await repository.createDirectory(
      space.id,
      { name: `Directory child ${suffix}`, parentDirectoryId: parent.id },
      context,
    );
    const targetA = await repository.createDirectory(
      space.id,
      { name: `Directory target A ${suffix}` },
      context,
    );
    const targetB = await repository.createDirectory(
      space.id,
      { name: `Directory target B ${suffix}` },
      context,
    );

    const outcomes = await Promise.allSettled([
      repository.moveDirectoryTree(
        parent.id,
        { targetParentId: targetA.id, version: parent.version },
        context,
      ),
      repository.moveDirectoryTree(
        parent.id,
        { targetParentId: targetB.id, version: parent.version },
        context,
      ),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const movedParent = await repository.getDirectory(parent.id, context);
    const winnerId = String(movedParent.parentDirectoryId);
    expect([targetA.id, targetB.id]).toContain(winnerId);
    expect(movedParent.path).toEqual([winnerId]);
    expect(movedParent.version).toBe(parent.version + 1);
    const movedChild = await repository.getDirectory(child.id, context);
    expect(movedChild.path).toEqual([winnerId, parent.id]);
    expect(movedChild.version).toBe(child.version + 1);
  });

  it('allows exactly one same-version Source move', async () => {
    const space = await repository.createSpace(
      {
        kind: 'space',
        name: `Source CAS ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context,
    );
    const source = await repository.createSource(
      space.id,
      { kind: 'text', name: `Source CAS ${suffix}` },
      context,
    );
    const targetA = await repository.createDirectory(
      space.id,
      { name: `Source target A ${suffix}` },
      context,
    );
    const targetB = await repository.createDirectory(
      space.id,
      { name: `Source target B ${suffix}` },
      context,
    );

    const outcomes = await Promise.allSettled([
      repository.moveSource(
        source.id,
        { targetParentId: targetA.id, version: source.version },
        context,
      ),
      repository.moveSource(
        source.id,
        { targetParentId: targetB.id, version: source.version },
        context,
      ),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const moved = await repository.getSource(source.id, context);
    expect([targetA.id, targetB.id]).toContain(String(moved.directoryId));
    expect(moved.version).toBe(source.version + 1);
  });

  it('allows exactly one same-version batch item to commit', async () => {
    const resource = await repository.createSpace(
      {
        kind: 'space',
        name: `Batch CAS ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context,
    );
    const targetA = await repository.createSpace(
      {
        kind: 'folder',
        name: `Batch target A ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'inherited',
        sourcePermissionEnabled: true,
      },
      context,
    );
    const targetB = await repository.createSpace(
      {
        kind: 'folder',
        name: `Batch target B ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'inherited',
        sourcePermissionEnabled: true,
      },
      context,
    );
    const moveBatch = (targetParentId: string) =>
      application.dispatch({
        operationId: 'API-SPACE-BATCH',
        params: {},
        query: {},
        headers: {},
        body: {
          action: 'move',
          ids: [resource.id],
          targetParentId,
          versions: { [resource.id]: resource.version },
        },
        context,
      });

    const results = await Promise.all([moveBatch(targetA.id), moveBatch(targetB.id)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 207]);
    const moved = await repository.getSpace(resource.id, context);
    expect([targetA.id, targetB.id]).toContain(String(moved.parentSpaceId));
    expect(moved.version).toBe(resource.version + 1);
  });
});
