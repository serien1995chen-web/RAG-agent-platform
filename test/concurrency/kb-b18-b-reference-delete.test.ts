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

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b18b_reference_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `member_${suffix}`,
  requestId: `req_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
  isWorkspaceOwner: true,
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let catalog: KnowledgeCatalogRepository;
let references: KnowledgeReferenceRepository;

beforeAll(async () => {
  const uri = process.env.KB_TEST_MONGO_URI?.trim();
  if (!uri) throw new Error('missing required test environment: KB_TEST_MONGO_URI');
  connection = await createKnowledgeMongoConnection(uri);
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  references = new KnowledgeReferenceRepository(connection);
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('TEST-X-REFERENCE-DELETE B18-B', () => {
  it('blocks delete for an active workflow and detaches with the latest referenceRevision', async () => {
    const space = await catalog.createSpace(
      {
        kind: 'space',
        name: `B18B reference ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context,
    );
    const applied = await references.applyUpsert(
      {
        spaceId: space.id,
        referrerType: 'workflow',
        referrerId: `workflow_${suffix}`,
        referrerVersion: 'v1',
        referrerName: 'B18B Workflow v1',
        registryRevision: 1,
      },
      context,
    );
    expect(applied.referenceRevision).toBe(1);
    const listed = await references.list(space.id, context);
    expect(listed.referenceRevision).toBe(1);
    expect(listed.items).toEqual([
      expect.objectContaining({
        referrerType: 'workflow',
        referrerId: `workflow_${suffix}`,
        referrerVersion: 'v1',
        status: 'active',
      }),
    ]);
    const currentWithReference = await catalog.getSpace(space.id, context);

    await expect(
      catalog.deleteSpace(
        space.id,
        {
          version: currentWithReference.version,
          expectedReferenceRevision: listed.referenceRevision,
          referenceStrategy: 'block',
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_REFERENCE_CONFLICT',
          details: { references: 1, strategy: 'block' },
        },
      },
    });

    const removed = await references.applyRemove(
      {
        spaceId: space.id,
        referrerType: 'workflow',
        referrerId: `workflow_${suffix}`,
        referrerVersion: 'v1',
        registryRevision: 2,
      },
      context,
    );
    expect(removed.referenceRevision).toBe(2);
    const afterDetach = await references.list(space.id, context);
    expect(afterDetach.items.filter((item) => item.status === 'active')).toEqual([]);
    expect(afterDetach.referenceRevision).toBe(2);

    const current = await catalog.getSpace(space.id, context);
    await expect(
      catalog.deleteSpace(
        space.id,
        {
          version: current.version,
          expectedReferenceRevision: afterDetach.referenceRevision,
          referenceStrategy: 'block',
        },
        context,
      ),
    ).resolves.toBeDefined();
  }, 120_000);
});
