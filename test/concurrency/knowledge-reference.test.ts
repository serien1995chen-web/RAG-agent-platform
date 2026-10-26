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

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_reference_concurrency_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `member_${suffix}`,
  requestId: `req_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
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

describe('reference revision concurrency', () => {
  it('converges concurrent identical revisions to one active binding and one revision increment', async () => {
    const target = await catalog.createSpace(
      {
        kind: 'space',
        name: `Reference concurrency ${suffix}`,
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      },
      context,
    );
    await references.applyUpsert(
      {
        spaceId: target.id,
        referrerType: 'workflow',
        referrerId: `workflow_${suffix}`,
        referrerVersion: 'v1',
        referrerName: 'Workflow v1',
        registryRevision: 1,
      },
      context,
    );
    const outcomes = await Promise.allSettled([
      references.applyUpsert(
        {
          spaceId: target.id,
          referrerType: 'workflow',
          referrerId: `workflow_${suffix}`,
          referrerVersion: 'v2',
          referrerName: 'Workflow v2 A',
          registryRevision: 2,
        },
        context,
      ),
      references.applyUpsert(
        {
          spaceId: target.id,
          referrerType: 'workflow',
          referrerId: `workflow_${suffix}`,
          referrerVersion: 'v2',
          referrerName: 'Workflow v2 B',
          registryRevision: 2,
        },
        context,
      ),
    ]);
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
    const listed = await references.list(target.id, context);
    expect(listed.referenceRevision).toBe(2);
    expect(listed.items.filter((item) => item.status === 'active')).toHaveLength(1);
    expect(listed.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ referrerVersion: 'v1', status: 'stale' }),
        expect.objectContaining({ referrerVersion: 'v2', status: 'active' }),
      ]),
    );
    expect(
      await connection.models.KnowledgeAuditEvent.countDocuments({
        workspaceId,
        action: 'reference.upsert',
        resourceId: target.id,
      }),
    ).toBe(2);
  });
});
