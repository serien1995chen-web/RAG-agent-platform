import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import {
  KnowledgeCatalogRepository,
  KnowledgeJobExecutionRepository,
  KnowledgeSegmentIndexRepository,
} from '../../packages/service/src/modules/knowledge';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b04_security_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_b04_security_${suffix}`,
  requestId: `req_b04_security_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: true,
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let catalog: KnowledgeCatalogRepository;
let jobs: KnowledgeJobExecutionRepository;
let indexes: KnowledgeSegmentIndexRepository;
let segmentId = '';

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  jobs = new KnowledgeJobExecutionRepository(connection);
  indexes = new KnowledgeSegmentIndexRepository(connection, jobs, {
    async listModels() {
      return [
        {
          modelId: 'mock-embedding-768',
          displayName: 'Mock embedding',
          type: 'embedding' as const,
          capabilities: ['text-embedding', 'dimension:768'],
          dimension: 768 as const,
          authorized: true,
        },
      ];
    },
  });

  const models = registerKnowledgeModels(connection);
  const knowledgeSpaceId = new connection.base.Types.ObjectId();
  const sourceId = new connection.base.Types.ObjectId();
  const segmentObjectId = new connection.base.Types.ObjectId();
  segmentId = String(segmentObjectId);
  await models.KnowledgeSource.create({
    _id: sourceId,
    workspaceId,
    knowledgeSpaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    directoryId: null,
    kind: 'text',
    name: `B04 security source ${suffix}`,
    externalId: null,
    connectorId: null,
    blobRefId: new connection.base.Types.ObjectId(),
    originalUrl: null,
    mimeType: 'text/plain',
    sizeBytes: 128,
    contentHash: `b04-security-${suffix}`,
    parseProvider: 'liteparse',
    processingStatus: 'ready',
    sourceVersion: 1,
    searchEnabled: true,
    permissionState: 'disabled',
    permissionRevision: 0,
    ownershipMemberId: context.memberId,
    metadata: {},
    tagValues: [],
  });
  await models.KnowledgeSegment.create({
    _id: segmentObjectId,
    workspaceId,
    knowledgeSpaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    sourceId,
    sourceVersion: 1,
    searchEnabled: true,
    order: 0,
    question: 'security target',
    answer: 'security target',
    content: 'security target',
    fullTextTokens: '',
    fullTextVersion: 0,
    metadata: {},
    history: [],
    indexes: [],
    indexStatus: 'indexed',
    indexErrorCode: null,
    imageBlobRefId: null,
    imageDescription: null,
    synonymVersion: 0,
  });
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('B04 input and tenant security', () => {
  it('L1-B04-DATA-001-N02 malformed Segment ID fails closed with a stable contract error', async () => {
    await expect(catalog.getSegment('not-an-object-id', context)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });

  it('L1-B04-DATA-002-N02 invalid index ID and empty text are rejected before persistence', async () => {
    await expect(
      indexes.upsert(
        segmentId,
        {
          indexId: 'contains spaces',
          type: 'custom',
          text: 'valid text',
          modelId: 'mock-embedding-768',
          version: 1,
        },
        'create',
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } } });
    await expect(
      indexes.upsert(
        segmentId,
        {
          indexId: 'custom_empty',
          type: 'custom',
          text: '   ',
          modelId: 'mock-embedding-768',
          version: 1,
        },
        'create',
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } } });
    expect(await catalog.getSegment(segmentId, context)).toMatchObject({
      version: 1,
      indexes: [],
    });
  });

  it('L1-B04-DATA-003-N02 malformed or missing Job lookup cannot expose internal storage details', async () => {
    await expect(jobs.getRaw('not-a-job-id', context)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    const missingJobId = new connection.base.Types.ObjectId().toString();
    await expect(jobs.getRaw(missingJobId, context)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    await expect(
      jobs.getRaw(missingJobId, { memberId: context.memberId } as TenantContext),
    ).rejects.toBeTruthy();
  });
});
