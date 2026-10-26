import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KnowledgeCatalogRepository,
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
