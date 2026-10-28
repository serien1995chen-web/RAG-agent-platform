import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { KnowledgeJobExecutionRepository } from '../../packages/service/src/modules/knowledge/repository/job-execution.repository';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s6_fault_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s6_fault_${suffix}`,
  requestId: `req_s6_fault_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
};
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let repository: KnowledgeJobExecutionRepository;

beforeAll(async () => {
  const uri = new URL(requiredEnv('KB_TEST_MONGO_URI'));
  if (uri.hostname === '127.0.0.1' || uri.hostname === 'localhost') {
    uri.searchParams.set('directConnection', 'true');
  }
  connection = await createKnowledgeMongoConnection(uri.toString());
  await ensureKnowledgeCollections(connection);
  repository = new KnowledgeJobExecutionRepository(connection);
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('S6 worker restart and fencing', () => {
  it('recovers an expired lease and rejects the stale worker commit', async () => {
    const job = await repository.create(
      {
        kind: 'index',
        resourceType: 'segment',
        resourceId: randomUUID().replaceAll('-', '').slice(0, 24),
        knowledgeSpaceId: randomUUID().replaceAll('-', '').slice(0, 24),
        inputSnapshot: { segmentVersion: 1 },
        priority: 5,
        idempotencyKey: `s6-fault-${suffix}`,
      },
      context,
    );
    const claimed = await repository.claimById(
      { jobId: job.jobId, kinds: ['index'], workerId: `dead-worker-${suffix}` },
      context,
    );
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeJob.updateOne(
      { _id: job.jobId, workspaceId },
      { $set: { status: 'running', leaseExpiresAt: new Date(Date.now() - 1_000) } },
    );
    expect(await repository.recoverExpiredLeases(context)).toBe(1);
    const recovered = await repository.getRaw(job.jobId, context);
    expect(recovered.status).toBe('retry_wait');
    await expect(
      repository.commit(
        job.jobId,
        claimed!.version,
        recovered.attemptEpoch,
        'stale-worker-token',
        `dead-worker-${suffix}`,
        { stale: true },
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
    await models.KnowledgeJob.updateOne(
      { _id: job.jobId, workspaceId },
      { $set: { availableAt: new Date(Date.now() - 1_000) } },
    );
    expect(await repository.requeueDueRetries(context)).toBe(1);
    expect((await repository.getRaw(job.jobId, context)).status).toBe('queued');
    expect(
      await models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateId: job.jobId,
        eventType: 'index.job.retry',
      }),
    ).toBe(1);
  });
});
