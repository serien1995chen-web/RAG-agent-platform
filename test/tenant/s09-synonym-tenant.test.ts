import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import { KnowledgeSynonymRepository } from '../../packages/service/src/modules/knowledge/repository/s09-synonym.repository';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceA = `ws_s9_tenant_a_${suffix}`;
const workspaceB = `ws_s9_tenant_b_${suffix}`;
const knowledgeSpaceId = '65f1e5b2a1c9d4b7e8f01234';
const contextA: TenantContext = {
  workspaceId: workspaceA,
  memberId: `mem_a_${suffix}`,
  requestId: `req_a_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:admin'],
};
const contextB: TenantContext = {
  ...contextA,
  workspaceId: workspaceB,
  memberId: `mem_b_${suffix}`,
  requestId: `req_b_${suffix}`,
};
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let repository: KnowledgeSynonymRepository;

beforeAll(async () => {
  const uri = new URL(requiredEnv('KB_TEST_MONGO_URI'));
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = await createKnowledgeMongoConnection(uri.toString());
  await ensureKnowledgeCollections(connection);
  repository = new KnowledgeSynonymRepository(connection);
  const models = registerKnowledgeModels(connection);
  await models.KnowledgeSynonymConfig.create({
    workspaceId: workspaceA,
    knowledgeSpaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: contextA.memberId,
    updatedByMemberId: contextA.memberId,
    fileName: 'tenant.csv',
    sizeBytes: 10,
    checksumSha256: 'd'.repeat(64),
    activeFileVersion: 1,
    publishedFileVersion: 1,
    lastFileVersion: 1,
    pendingFileVersion: null,
    pendingJobId: null,
    pendingReason: null,
    pendingStartedAt: null,
    pendingSourceIds: [],
    enabled: true,
    schemaVersion: 2,
    status: 'active',
    uploadTime: new Date(),
    uploadedByMemberId: contextA.memberId,
    lastError: null,
    activeQueryModelId: null,
    activeQueryDimension: null,
  });
}, 60_000);

afterAll(async () => {
  if (connection) {
    for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
      await connection.models[entry.modelName]?.deleteMany({
        workspaceId: { $in: [workspaceA, workspaceB] },
      });
    }
    await connection.close();
  }
});

describe('S9 synonym tenant isolation', () => {
  it('TEST-AUTH-001-BLOCK hides synonym configuration and mappings across tenants', async () => {
    await expect(repository.getConfig(String(knowledgeSpaceId), contextA)).resolves.toMatchObject({
      knowledgeSpaceId: String(knowledgeSpaceId),
    });
    await expect(repository.getConfig(String(knowledgeSpaceId), contextB)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    await expect(
      repository.listMappings(String(knowledgeSpaceId), { limit: 20 }, contextB),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    expect(await repository.getPublishedSnapshot(String(knowledgeSpaceId), contextB)).toBeNull();
    expect(await repository.assertPublishedVersion(String(knowledgeSpaceId), 1, contextB)).toBe(
      false,
    );
  });
});
