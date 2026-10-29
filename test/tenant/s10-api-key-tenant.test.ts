import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeAccessRepository } from '../../packages/service/src/modules/knowledge/repository/access.repository';
import { KnowledgeCatalogRepository } from '../../packages/service/src/modules/knowledge/repository/catalog.repository';
import { S10ApiKeyRepository } from '../../packages/service/src/modules/knowledge/repository/s10-api-key.repository';
import { S10OperationsRepository } from '../../packages/service/src/modules/knowledge/repository/s10-operations.repository';
import { hashApiKeySecret } from '../../packages/service/src/modules/knowledge/domain/s10-api-key';
import { KnowledgeAuditRepository } from '../../packages/service/src/shared/persistence/knowledge/audit';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceA = `ws_s10_tenant_a_${suffix}`;
const workspaceB = `ws_s10_tenant_b_${suffix}`;
const contextA: TenantContext = {
  workspaceId: workspaceA,
  memberId: `mem_a_${suffix}`,
  requestId: `req_a_${suffix}`,
  traceId: suffix.padEnd(32, 'a').slice(0, 32),
  scopes: ['knowledge:admin'],
  isWorkspaceOwner: true,
};
const contextB: TenantContext = {
  ...contextA,
  workspaceId: workspaceB,
  memberId: `mem_b_${suffix}`,
  requestId: `req_b_${suffix}`,
  traceId: suffix.padEnd(32, 'b').slice(0, 32),
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let catalog: KnowledgeCatalogRepository;
let keys: S10ApiKeyRepository;
let access: KnowledgeAccessRepository;
let audits: KnowledgeAuditRepository;
let operations: S10OperationsRepository;

beforeAll(async () => {
  const value = process.env.KB_TEST_MONGO_URI?.trim();
  if (!value) throw new Error('missing required test environment: KB_TEST_MONGO_URI');
  connection = await createKnowledgeMongoConnection(value);
  catalog = new KnowledgeCatalogRepository(connection);
  keys = new S10ApiKeyRepository(connection);
  access = new KnowledgeAccessRepository(connection);
  audits = new KnowledgeAuditRepository(connection);
  operations = new S10OperationsRepository(connection, { enqueue: async () => ({}) } as never);
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId: { $in: [workspaceA, workspaceB] } });
  }
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId: { $in: [workspaceA, workspaceB] } });
  }
  await connection.close();
});

async function createSpace(name: string) {
  return catalog.createSpace(
    {
      kind: 'space',
      parentSpaceId: null,
      name,
      description: '',
      iconKey: 'book-open',
      accessMode: 'workspace',
      sourceAclMode: 'inherited',
      sourcePermissionEnabled: true,
    },
    contextA,
  );
}

describe('TEST-X-TENANT-GUARD S10 API Key tenant and Space scope', () => {
  it('returns 404 across workspaces and 403 across a restricted Key Space scope', async () => {
    const allowed = await createSpace('Allowed');
    const denied = await createSpace('Denied');
    const secret = 'kn_live_tenant-test-secret-0123456789abcdef';
    const key = await keys.create(
      {
        name: 'restricted',
        scopes: ['knowledge:read'],
        spaceIds: [allowed.id],
        expiresAt: null,
      },
      {
        keyPrefix: secret.slice(0, 12),
        secretHash: hashApiKeySecret(secret, 'tenant-hmac'),
      },
      contextA,
    );
    expect(await keys.list({ limit: 10 }, contextB)).toMatchObject({
      items: [],
      pageInfo: { hasMore: false },
    });
    await expect(
      keys.update(key.id, { name: 'cross-tenant', version: key.version }, contextB),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    await expect(
      access.assertPermission('space', allowed.id, 'read', {
        ...contextA,
        isWorkspaceOwner: false,
        scopes: ['knowledge:read'],
        apiKeySpaceIds: [allowed.id],
        apiKeyId: key.id,
      }),
    ).resolves.toBeDefined();
    await expect(
      access.assertPermission('space', denied.id, 'read', {
        ...contextA,
        isWorkspaceOwner: false,
        scopes: ['knowledge:read'],
        apiKeySpaceIds: [allowed.id],
        apiKeyId: key.id,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });

    await audits.appendStandalone(
      {
        knowledgeSpaceId: null,
        action: 'api_key.list',
        resourceType: 'api_key',
        resourceId: key.id,
        outcome: 'succeeded',
        safeDiff: { actor: contextA.memberId },
      },
      contextA,
    );
    expect(
      (await operations.list({ action: 'api_key.list', limit: 10 }, contextA)).items,
    ).toHaveLength(1);
    expect(await operations.list({ limit: 10 }, contextB)).toEqual({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false },
    });
  });
});
