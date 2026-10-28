import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import {
  stableLogicalIds,
  validateMappings,
} from '../../packages/service/src/modules/knowledge/domain/s09-synonym';
import { KnowledgeSynonymRepository } from '../../packages/service/src/modules/knowledge/repository/s09-synonym.repository';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s9_concurrency_${suffix}`;
const knowledgeSpaceId = '65f1e5b2a1c9d4b7e8f01234';
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s9_concurrency_${suffix}`,
  requestId: `req_s9_concurrency_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:admin'],
};
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let repository: KnowledgeSynonymRepository;

async function createConfig() {
  const models = registerKnowledgeModels(connection);
  await models.KnowledgeSynonymConfig.create({
    workspaceId,
    knowledgeSpaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    fileName: 'existing.csv',
    sizeBytes: 10,
    checksumSha256: 'a'.repeat(64),
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
    uploadedByMemberId: context.memberId,
    lastError: null,
    activeQueryModelId: 'embedding-768',
    activeQueryDimension: 768,
  });
}

function mappings(checksum: string) {
  const validation = validateMappings([
    {
      rowNumber: 1,
      cells: [
        { columnNumber: 1, value: '标准词' },
        { columnNumber: 2, value: '同义词' },
      ],
    },
    {
      rowNumber: 2,
      cells: [
        { columnNumber: 1, value: `standard-${checksum.slice(0, 4)}` },
        { columnNumber: 2, value: `alias-${checksum.slice(0, 4)}` },
      ],
    },
  ]);
  if (!validation.ok) throw new Error('invalid fixture');
  return stableLogicalIds({
    workspaceId,
    knowledgeSpaceId: String(knowledgeSpaceId),
    mappings: validation.mappings,
  });
}

function pendingInput(checksum: string, key: string) {
  return {
    expectedFileVersion: 1,
    enabled: true,
    reason: 'synonym_change' as const,
    fileName: `${checksum.slice(0, 8)}.csv`,
    mimeType: 'text/csv',
    sizeBytes: 20,
    checksumSha256: checksum,
    mappings: mappings(checksum),
    rawFile: {
      blobId: 'unused',
      provider: 'minio' as const,
      bucket: 'kb-local',
      objectKey: `${checksum}.csv`,
      mimeType: 'text/csv',
      sizeBytes: 20,
      etag: 'etag',
      sha256: checksum,
      originalName: 'synonyms.csv',
    },
    sourceIds: [],
    idempotencyKey: key,
    requestHash: createHash('sha256').update(key).digest('hex'),
  };
}

beforeAll(async () => {
  const uri = new URL(requiredEnv('KB_TEST_MONGO_URI'));
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = await createKnowledgeMongoConnection(uri.toString());
  await ensureKnowledgeCollections(connection);
  repository = new KnowledgeSynonymRepository(connection);
}, 60_000);

afterAll(async () => {
  if (connection) {
    for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
      await connection.models[entry.modelName]?.deleteMany({ workspaceId });
    }
    await connection.close();
  }
});

describe('S9 synonym concurrency', () => {
  beforeEach(async () => {
    for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
      await connection.models[entry.modelName]?.deleteMany({ workspaceId });
    }
    await createConfig();
  });

  it('TEST-TRAIN-006-BLOCK allows only one concurrent next file version', async () => {
    const results = await Promise.allSettled([
      repository.createPendingVersion(
        String(knowledgeSpaceId),
        pendingInput('b'.repeat(64), `concurrent-a-${suffix}`),
        context,
      ),
      repository.createPendingVersion(
        String(knowledgeSpaceId),
        pendingInput('c'.repeat(64), `concurrent-b-${suffix}`),
        context,
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const models = registerKnowledgeModels(connection);
    const config = await models.KnowledgeSynonymConfig.findOne({
      workspaceId,
      knowledgeSpaceId,
    }).lean();
    expect(config).toMatchObject({
      activeFileVersion: 2,
      pendingFileVersion: 2,
      status: 'rebuilding',
    });
    expect(
      await models.KnowledgeJob.countDocuments({
        workspaceId,
        kind: 'synonym_rebuild',
        'inputSnapshot.fileVersion': 2,
      }),
    ).toBe(1);
    expect(
      await models.KnowledgeSynonymMapping.countDocuments({
        workspaceId,
        fileVersion: 2,
      }),
    ).toBe(1);
  }, 60_000);

  it('TEST-AUTH-001-BLOCK allows only one config CAS mutation at a version', async () => {
    const results = await Promise.allSettled([
      repository.toggle(String(knowledgeSpaceId), { enabled: false, version: 1 }, context),
      repository.toggle(String(knowledgeSpaceId), { enabled: false, version: 1 }, context),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await repository.getConfig(String(knowledgeSpaceId), context)).toMatchObject({
      enabled: false,
      status: 'disabled',
      version: 2,
    });
  }, 60_000);
});
