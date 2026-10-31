import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeCatalogRepository } from '../../src/modules/knowledge/repository/catalog.repository';
import { S10ApiKeyRepository } from '../../src/modules/knowledge/repository/s10-api-key.repository';
import {
  hashApiKeySecret,
  rotateApiKeyState,
} from '../../src/modules/knowledge/domain/s10-api-key';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../src/shared/persistence/schemas/knowledge-index';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s10_key_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s10_key_${suffix}`,
  requestId: `req_s10_key_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:admin'],
  isWorkspaceOwner: true,
};

let connection: mongoose.Connection;
let repository: S10ApiKeyRepository;
let catalog: KnowledgeCatalogRepository;

beforeAll(async () => {
  const uri = new URL(process.env.KB_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/kb_s10_key');
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(uri.toString(), { serverSelectionTimeoutMS: 5_000 });
  await connection.asPromise();
  repository = new S10ApiKeyRepository(connection);
  catalog = new KnowledgeCatalogRepository(connection);
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
    context,
  );
}

describe('TEST-API-003-BLOCK real API Key lifecycle', () => {
  it('creates, lists, rotates and chain-revokes without exposing secretHash', async () => {
    const space = await createSpace('S10 API Key space');
    const secret = 'kn_live_example-secret-for-s10-testing-0123456789';
    const created = await repository.create(
      {
        name: 'search key',
        scopes: ['knowledge:read', 'knowledge:search'],
        spaceIds: [space.id],
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      {
        keyPrefix: secret.slice(0, 12),
        secretHash: hashApiKeySecret(secret, 'hmac-secret'),
      },
      context,
    );
    expect(created.status).toBe('active');
    expect(created.version).toBe(1);
    expect(JSON.stringify(created)).not.toContain('secretHash');

    const listed = await repository.list({ limit: 10 }, context);
    expect(listed.items).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(JSON.stringify(listed)).not.toContain('secretHash');
    expect(
      (await repository.findForAuthentication(workspaceId, created.keyPrefix, context))?.id,
    ).toBe(created.id);

    const successorSecret = 'kn_live_successor-secret-0123456789abcdef';
    const successor = await repository.rotate(
      created.id,
      created.version,
      {
        keyPrefix: successorSecret.slice(0, 12),
        secretHash: hashApiKeySecret(successorSecret, 'hmac-secret'),
      },
      context,
    );
    expect(successor.status).toBe('active');
    expect(successor.rotatedFromKeyId).toBe(created.id);
    const rotated = (await repository.list({ limit: 10 }, context)).items.find(
      (item) => item.id === created.id,
    );
    expect(rotated?.status).toBe('rotated');
    const expectedRetire = rotateApiKeyState(
      { status: 'active', expiresAt: new Date(created.expiresAt!) },
      new Date(),
    ).retireAt.getTime();
    expect(Math.abs(new Date(rotated!.retireAt!).getTime() - expectedRetire)).toBeLessThan(5_000);

    await repository.revoke(successor.id, successor.version, context);
    const final = await repository.list({ limit: 10 }, context);
    expect(final.items.every((item) => item.status === 'revoked')).toBe(true);
    expect(
      await repository.findForAuthentication(workspaceId, successor.keyPrefix, context),
    ).toBeNull();
  });

  it('updates fields with CAS and rejects inactive reactivation', async () => {
    const secret = 'kn_live_update-secret-0123456789abcdefghij';
    const created = await repository.create(
      {
        name: 'update key',
        scopes: ['knowledge:read'],
        spaceIds: [],
        expiresAt: null,
      },
      {
        keyPrefix: secret.slice(0, 12),
        secretHash: hashApiKeySecret(secret, 'hmac-secret'),
      },
      context,
    );
    const updated = await repository.update(
      created.id,
      { name: 'updated key', status: 'revoked', version: created.version },
      context,
    );
    expect(updated.name).toBe('updated key');
    expect(updated.status).toBe('revoked');
    await expect(
      repository.update(created.id, { status: 'active', version: updated.version }, context),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
  });
});
