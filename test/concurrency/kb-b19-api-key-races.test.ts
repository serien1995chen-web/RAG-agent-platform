import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  generateApiKeySecret,
  hashApiKeySecret,
} from '../../packages/service/src/modules/knowledge/domain/s10-api-key';
import { S10ApiKeyRepository } from '../../packages/service/src/modules/knowledge/repository/s10-api-key.repository';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b19_race_${suffix}`;
const hmacSecret = `b19-race-hmac-${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_b19_race_${suffix}`,
  requestId: `req_b19_race_${suffix}`,
  traceId: suffix.padEnd(32, 'b').slice(0, 32),
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

async function createActiveKey(label: string) {
  const generated = generateApiKeySecret(() => randomBytes(32));
  return keys.create(
    {
      name: `${label}-${suffix}`,
      scopes: ['knowledge:read'],
      spaceIds: [],
      expiresAt: null,
    },
    {
      keyPrefix: generated.prefix,
      secretHash: hashApiKeySecret(generated.secret, hmacSecret),
    },
    context,
  );
}

function successorSecret(label: string) {
  const generated = generateApiKeySecret(() => randomBytes(32));
  return {
    keyPrefix: generated.prefix,
    secretHash: hashApiKeySecret(`${generated.secret}-${label}`, hmacSecret),
  };
}

describe('L1-B19-API-003 concurrency', () => {
  it('L1-B19-API-003-C02 only one same-version rotate can create an active successor', async () => {
    const key = await createActiveKey('rotate-race');
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        keys.rotate(key.id, key.version, successorSecret(`rotate-${index}`), context),
      ),
    );
    const success = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const conflict = attempts.filter(
      (attempt) =>
        attempt.status === 'rejected' &&
        (attempt.reason as { problem?: { error?: { code?: string } } })?.problem?.error?.code ===
          'KNOWLEDGE_CONFLICT',
    );
    expect(success).toHaveLength(1);
    expect(conflict).toHaveLength(7);
    const items = (await keys.list({ limit: 200 }, context)).items;
    const successors = items.filter((item) => item.rotatedFromKeyId === key.id);
    expect(successors).toHaveLength(1);
    expect(successors[0]?.status).toBe('active');
    expect(items.find((item) => item.id === key.id)?.status).toBe('rotated');
  });

  it('L1-B19-API-003-C03 concurrent rotate and revoke leave one consistent chain', async () => {
    const key = await createActiveKey('rotate-revoke');
    const [rotateResult, revokeResult] = await Promise.allSettled([
      keys.rotate(key.id, key.version, successorSecret('race'), context),
      keys.revoke(key.id, key.version, context),
    ]);
    expect(
      [rotateResult.status, revokeResult.status].filter((value) => value === 'fulfilled'),
    ).toHaveLength(1);
    const items = (await keys.list({ limit: 200 }, context)).items;
    const root = items.find((item) => item.id === key.id);
    const successors = items.filter((item) => item.rotatedFromKeyId === key.id);
    expect(successors.length).toBeLessThanOrEqual(1);
    expect(root?.status).toMatch(/rotated|revoked/);
    if (successors.length === 0) {
      expect(root?.status).toBe('revoked');
    } else {
      expect(root?.rotatedToKeyId).toBe(successors[0]?.id);
      expect(items.every((item) => item.status !== 'active' || item.id === successors[0]?.id)).toBe(
        true,
      );
    }
  });
});
