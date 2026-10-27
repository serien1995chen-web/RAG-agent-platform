import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { KnowledgeJobExecutionRepository } from '../../packages/service/src/modules/knowledge/repository/job-execution.repository';
import { KnowledgeSegmentIndexRepository } from '../../packages/service/src/modules/knowledge/repository/segment-index.repository';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceA = `ws_s6_tenant_a_${suffix}`;
const workspaceB = `ws_s6_tenant_b_${suffix}`;
const contextA: TenantContext = {
  workspaceId: workspaceA,
  memberId: `mem_a_${suffix}`,
  requestId: `req_a_${suffix}`,
  traceId: suffix.padEnd(32, 'a').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
};
const contextB: TenantContext = {
  workspaceId: workspaceB,
  memberId: `mem_b_${suffix}`,
  requestId: `req_b_${suffix}`,
  traceId: suffix.padEnd(32, 'b').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let jobs: KnowledgeJobExecutionRepository;
let segmentIndexes: KnowledgeSegmentIndexRepository;

beforeAll(async () => {
  const uri = new URL(requiredEnv('KB_TEST_MONGO_URI'));
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = await createKnowledgeMongoConnection(uri.toString());
  await ensureKnowledgeCollections(connection);
  jobs = new KnowledgeJobExecutionRepository(connection);
  segmentIndexes = new KnowledgeSegmentIndexRepository(connection, jobs, {
    async listModels() {
      return [];
    },
  });
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({
      workspaceId: { $in: [workspaceA, workspaceB] },
    });
  }
  await connection.close();
});

describe('S6 Job and index tenant isolation', () => {
  it('hides another workspace Job, subtree and Segment history', async () => {
    const knowledgeSpaceA = new connection.base.Types.ObjectId();
    const sourceId = new connection.base.Types.ObjectId();
    const job = await jobs.create(
      {
        kind: 'rebuild',
        resourceType: 'source',
        resourceId: String(sourceId),
        knowledgeSpaceId: String(knowledgeSpaceA),
        inputSnapshot: {
          sourceId: String(sourceId),
          sourceVersion: 1,
          reason: 'manual',
          expectedSegmentVersions: [],
        },
        priority: 5,
        idempotencyKey: `tenant-job-${suffix}`,
      },
      contextA,
    );
    const child = await jobs.createChild(
      {
        kind: 'index',
        resourceType: 'segment',
        resourceId: String(new connection.base.Types.ObjectId()),
        knowledgeSpaceId: String(knowledgeSpaceA),
        inputSnapshot: { operation: 'reindex', sourceVersion: 1 },
        rootJobId: job.jobId,
        parentJobId: job.jobId,
        priority: 5,
        idempotencyKey: `tenant-child-${suffix}`,
      },
      contextA,
    );
    const models = registerKnowledgeModels(connection);
    const segmentId = new connection.base.Types.ObjectId();
    await models.KnowledgeSegment.create({
      _id: segmentId,
      workspaceId: workspaceA,
      knowledgeSpaceId: knowledgeSpaceA,
      version: 1,
      deletedAt: null,
      createdByMemberId: contextA.memberId,
      updatedByMemberId: contextA.memberId,
      sourceId,
      sourceVersion: 1,
      searchEnabled: true,
      order: 0,
      question: 'Tenant question',
      answer: 'Tenant answer',
      content: 'Tenant question\nTenant answer',
      fullTextTokens: 'tenant',
      fullTextVersion: 1,
      metadata: {},
      history: [],
      indexes: [],
      indexStatus: 'pending',
      indexErrorCode: null,
      imageBlobRefId: null,
      imageDescription: null,
      synonymVersion: 0,
    });

    await expect(jobs.getRaw(job.jobId, contextB)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    expect(await jobs.children(job.jobId, contextB)).toEqual([]);
    expect(await jobs.getRaw(child.jobId, contextA)).toMatchObject({ kind: 'index' });
    await expect(segmentIndexes.history(String(segmentId), contextB)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
  });
});
