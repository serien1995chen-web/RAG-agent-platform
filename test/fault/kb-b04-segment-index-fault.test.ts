import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { KnowledgeJobExecutionRepository } from '../../packages/service/src/modules/knowledge';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b04_fault_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_b04_fault_${suffix}`,
  requestId: `req_b04_fault_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: true,
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let jobs: KnowledgeJobExecutionRepository;

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  await ensureKnowledgeCollections(connection);
  jobs = new KnowledgeJobExecutionRepository(connection);
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('B04 index fault recovery', () => {
  it('L1-B04-DATA-003-F01 worker restart requeues once and preserves one retry side effect', async () => {
    const job = await jobs.create(
      {
        kind: 'index',
        resourceType: 'segment',
        resourceId: randomUUID().replaceAll('-', '').slice(0, 24),
        knowledgeSpaceId: randomUUID().replaceAll('-', '').slice(0, 24),
        inputSnapshot: { segmentVersion: 1 },
        priority: 5,
        idempotencyKey: `b04-fault-${suffix}`,
      },
      context,
    );
    const claimed = await jobs.claimById(
      {
        jobId: job.jobId,
        kinds: ['index'],
        workerId: `b04-dead-worker-${suffix}`,
      },
      context,
    );
    expect(claimed).toBeTruthy();
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeJob.updateOne(
      { _id: job.jobId, workspaceId },
      { $set: { status: 'running', leaseExpiresAt: new Date(Date.now() - 1_000) } },
    );

    expect(await jobs.recoverExpiredLeases(context)).toBe(1);
    expect((await jobs.getRaw(job.jobId, context)).status).toBe('retry_wait');
    await models.KnowledgeJob.updateOne(
      { _id: job.jobId, workspaceId },
      { $set: { availableAt: new Date(Date.now() - 1_000) } },
    );
    expect(await jobs.requeueDueRetries(context)).toBe(1);
    expect((await jobs.getRaw(job.jobId, context)).status).toBe('queued');

    expect(await jobs.recoverExpiredLeases(context)).toBe(0);
    expect(await jobs.requeueDueRetries(context)).toBe(0);
    expect(
      await models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateId: job.jobId,
        eventType: 'index.job.retry',
      }),
    ).toBe(1);
  });
});
