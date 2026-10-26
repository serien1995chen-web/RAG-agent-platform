import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KnowledgeCatalogRepository } from '../../packages/service/src/modules/knowledge';
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
};
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let repository: KnowledgeCatalogRepository;

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  await ensureKnowledgeCollections(connection);
  repository = new KnowledgeCatalogRepository(connection);
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
});
