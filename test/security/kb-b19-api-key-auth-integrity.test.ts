import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeApiKeyAuthProvider } from '../../packages/service/src/modules/knowledge/adapter/auth.adapter';
import { hashApiKeySecret } from '../../packages/service/src/modules/knowledge/domain/s10-api-key';
import { S10ApiKeyRepository } from '../../packages/service/src/modules/knowledge/repository/s10-api-key.repository';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b19_auth_${suffix}`;
const hmacSecret = `b19-auth-hmac-${suffix}-0123456789abcdef`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_b19_auth_${suffix}`,
  requestId: `req_b19_auth_${suffix}`,
  traceId: suffix.padEnd(32, 'a').slice(0, 32),
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

describe('L1-B19-API-003 authentication integrity', () => {
  it('L1-B19-API-003-A02 workspace-unique prefixes prevent ambiguous HMAC authentication', async () => {
    const firstSecret = `kn_live_abcd${'A'.repeat(43)}`;
    const secondSecret = `kn_live_abcd${'B'.repeat(43)}`;
    expect(firstSecret.slice(0, 12)).toBe(secondSecret.slice(0, 12));
    const first = await keys.create(
      {
        name: `same-prefix-first-${suffix}`,
        scopes: ['knowledge:read'],
        spaceIds: [],
        expiresAt: null,
      },
      {
        keyPrefix: firstSecret.slice(0, 12),
        secretHash: hashApiKeySecret(firstSecret, hmacSecret),
      },
      context,
    );
    await expect(
      keys.create(
        {
          name: `same-prefix-second-${suffix}`,
          scopes: ['knowledge:read'],
          spaceIds: [],
          expiresAt: null,
        },
        {
          keyPrefix: secondSecret.slice(0, 12),
          secretHash: hashApiKeySecret(secondSecret, hmacSecret),
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 11000 });

    const provider = new KnowledgeApiKeyAuthProvider(keys, hmacSecret);
    const subject = await provider.authenticate({
      authorization: `Bearer ${firstSecret}`,
      workspaceId,
      requestId: `req_b19_prefix_${suffix}`,
      traceId: context.traceId,
    });
    expect(subject).toMatchObject({
      authType: 'api_key',
      apiKeyId: first.id,
      scopes: ['knowledge:read'],
    });

    await expect(
      provider.authenticate({
        authorization: `Bearer ${firstSecret.slice(0, -1)}C`,
        workspaceId,
        requestId: `req_b19_prefix_wrong_${suffix}`,
        traceId: context.traceId,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_AUTH_REQUIRED' } },
    });
  });
});
