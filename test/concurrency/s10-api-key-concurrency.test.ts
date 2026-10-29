import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { S10ApiKeyRepository } from '../../packages/service/src/modules/knowledge/repository/s10-api-key.repository';
import { hashApiKeySecret } from '../../packages/service/src/modules/knowledge/domain/s10-api-key';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s10_key_cas_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s10_key_cas_${suffix}`,
  requestId: `req_s10_key_cas_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:admin'],
  isWorkspaceOwner: true,
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let keys: S10ApiKeyRepository;

beforeAll(async () => {
  const value = process.env.KB_TEST_MONGO_URI?.trim();
  if (!value) throw new Error('missing required test environment: KB_TEST_MONGO_URI');
  connection = await createKnowledgeMongoConnection(value);
  keys = new S10ApiKeyRepository(connection);
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('TEST-S10-API-KEY-CAS', () => {
  it('allows exactly one version winner across concurrent updates', async () => {
    const secret = 'kn_live_cas-test-secret-0123456789abcdef';
    const created = await keys.create(
      {
        name: 'cas key',
        scopes: ['knowledge:read'],
        spaceIds: [],
        expiresAt: null,
      },
      {
        keyPrefix: secret.slice(0, 12),
        secretHash: hashApiKeySecret(secret, 'cas-hmac'),
      },
      context,
    );
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        keys
          .update(created.id, { name: `cas winner ${index}`, version: created.version }, context)
          .then(() => 'pass' as const)
          .catch((error: unknown) => {
            expect(error).toMatchObject({
              problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
            });
            return 'conflict' as const;
          }),
      ),
    );
    expect(results.filter((value) => value === 'pass')).toHaveLength(1);
    expect(results.filter((value) => value === 'conflict')).toHaveLength(9);
    const items = (await keys.list({ limit: 10 }, context)).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.version).toBe(2);
  });
});
