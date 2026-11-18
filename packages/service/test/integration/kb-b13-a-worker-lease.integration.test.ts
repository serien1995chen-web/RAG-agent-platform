import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import { KnowledgeJobExecutionRepository } from '../../src/modules/knowledge/repository/job-execution.repository';
import { createKnowledgeMongoConnection } from '../../src/shared/runtime/knowledge-connections';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b13a_lease_${suffix}`;
const knowledgeSpaceId = new mongoose.Types.ObjectId().toString();
const context: TenantContext = {
  workspaceId,
  memberId: `b13a_lease_mem_${suffix}`,
  requestId: `b13a_lease_req_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
};
const otherContext: TenantContext = {
  ...context,
  workspaceId: `ws_b13a_other_${suffix}`,
  memberId: `b13a_other_mem_${suffix}`,
};

let connection: ReturnType<typeof createKnowledgeMongoConnection>;
let repository: KnowledgeJobExecutionRepository;

async function createIndexJob(key: string) {
  return repository.create(
    {
      kind: 'index',
      resourceType: 'segment',
      resourceId: new mongoose.Types.ObjectId().toString(),
      knowledgeSpaceId,
      inputSnapshot: { segmentVersion: 1, modelId: 'mock-embedding-1024' },
      priority: 5,
      idempotencyKey: `b13a-lease-${suffix}-${key}`,
    },
    context,
  );
}

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
    await connection.models[entry.modelName]?.deleteMany({ workspaceId: otherContext.workspaceId });
  }
  await connection.close();
});

describe('B13-A Worker lease and fencing', () => {
  it('L1-B13-A-TRAIN-002-P01 claims, starts, heartbeats and commits one fenced job', async () => {
    const created = await createIndexJob('p01');
    expect(created.status).toBe('queued');
    expect(created.attemptEpoch).toBe(0);
    expect(created.leaseOwner).toBeNull();

    const claimed = await repository.claimById(
      { jobId: created.jobId, kinds: ['index'], workerId: `worker-${suffix}` },
      context,
    );
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('leased');
    expect(claimed!.attemptEpoch).toBe(1);
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.leaseOwner).toBe(`worker-${suffix}`);
    expect(claimed!.leaseExpiresAt).not.toBeNull();

    const raw = await repository.getRaw(created.jobId, context);
    const fence = String(raw.fencingToken);
    expect(fence).not.toBe('unassigned');
    const started = await repository.start(
      created.jobId,
      claimed!.version,
      claimed!.attemptEpoch,
      fence,
      `worker-${suffix}`,
      context,
    );
    expect(started.status).toBe('running');
    expect(started.version).toBeGreaterThan(claimed!.version);

    const heartbeat = await repository.heartbeat(
      created.jobId,
      started.version,
      started.attemptEpoch,
      fence,
      `worker-${suffix}`,
      context,
    );
    expect(heartbeat.status).toBe('running');
    expect(new Date(heartbeat.leaseExpiresAt!).getTime()).toBeGreaterThan(Date.now());
    expect(heartbeat.version).toBeGreaterThan(started.version);

    await expect(
      repository.commit(
        created.jobId,
        heartbeat.version,
        heartbeat.attemptEpoch,
        'forged-fence',
        `worker-${suffix}`,
        { result: 'forged' },
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });

    const committed = await repository.commit(
      created.jobId,
      heartbeat.version,
      heartbeat.attemptEpoch,
      fence,
      `worker-${suffix}`,
      { result: 'ok' },
      context,
    );
    expect(committed.status).toBe('succeeded');
    expect(committed.progress).toMatchObject({ stage: 'succeeded', percent: 100 });
    expect(committed.result).toMatchObject({ result: 'ok' });
  });

  it('L1-B13-A-TRAIN-002-N03 moves an expired lease to retry_wait and requeues it once', async () => {
    const created = await createIndexJob('n03');
    const claimed = await repository.claimById(
      { jobId: created.jobId, kinds: ['index'], workerId: `dead-${suffix}` },
      context,
    );
    expect(claimed).not.toBeNull();
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeJob.updateOne(
      { _id: created.jobId, workspaceId },
      { $set: { status: 'running', leaseExpiresAt: new Date(Date.now() - 1_000) } },
    );
    expect(await repository.recoverExpiredLeases(context)).toBe(1);
    const recovered = await repository.getRaw(created.jobId, context);
    expect(recovered.status).toBe('retry_wait');
    expect(recovered.leaseOwner).toBeNull();
    expect(recovered.error).toMatchObject({
      code: 'KNOWLEDGE_JOB_FAILED',
      reason: 'lease_expired',
    });

    await models.KnowledgeJob.updateOne(
      { _id: created.jobId, workspaceId },
      { $set: { availableAt: new Date(Date.now() - 1_000) } },
    );
    expect(await repository.requeueDueRetries(context)).toBe(1);
    const requeued = await repository.getRaw(created.jobId, context);
    expect(requeued.status).toBe('queued');
    expect(
      await models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateId: created.jobId,
        eventType: 'index.job.retry',
      }),
    ).toBe(1);
  });

  it('L1-B13-A-TRAIN-002-S02 preserves attempts, epoch and error across a retryable failure', async () => {
    const created = await createIndexJob('s02');
    const claimed = await repository.claimById(
      { jobId: created.jobId, kinds: ['index'], workerId: `retry-${suffix}` },
      context,
    );
    const raw = await repository.getRaw(created.jobId, context);
    const fence = String(raw.fencingToken);
    const started = await repository.start(
      created.jobId,
      claimed!.version,
      raw.attemptEpoch,
      fence,
      `retry-${suffix}`,
      context,
    );
    const failed = await repository.fail(
      created.jobId,
      started.version,
      raw.attemptEpoch,
      fence,
      `retry-${suffix}`,
      true,
      'KNOWLEDGE_DEPENDENCY_TIMEOUT',
      context,
      { stage: 'embed' },
    );
    expect(failed.status).toBe('retry_wait');
    expect(failed.attempts).toBe(1);
    expect(failed.attemptEpoch).toBe(1);
    expect(failed.error).toMatchObject({ code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT', retryable: true });
  });

  it('L1-B13-A-TRAIN-002-A01 hides and rejects jobs from another workspace', async () => {
    const created = await createIndexJob('a01');
    await expect(repository.getRaw(created.jobId, otherContext)).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    expect(
      await repository.claimById(
        { jobId: created.jobId, kinds: ['index'], workerId: `other-${suffix}` },
        otherContext,
      ),
    ).toBeNull();
    await expect(
      repository.commit(
        created.jobId,
        1,
        0,
        'unassigned',
        `other-${suffix}`,
        { stolen: true },
        otherContext,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
  });

  it('L1-B13-A-TRAIN-002-N02 refuses to claim a job with the wrong kind', async () => {
    const created = await createIndexJob('wrong-kind');
    expect(
      await repository.claimById(
        { jobId: created.jobId, kinds: ['parse'], workerId: `wrong-${suffix}` },
        context,
      ),
    ).toBeNull();
    expect((await repository.getRaw(created.jobId, context)).status).toBe('queued');
  });

  it('L1-B13-A-TRAIN-002-N05 rejects an expired-heartbeat attempt from the former worker', async () => {
    const created = await createIndexJob('expired-heartbeat');
    const workerId = `expired-${suffix}`;
    const claimed = await repository.claimById(
      { jobId: created.jobId, kinds: ['index'], workerId },
      context,
    );
    const raw = await repository.getRaw(created.jobId, context);
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeJob.updateOne(
      { _id: created.jobId, workspaceId },
      { $set: { leaseExpiresAt: new Date(Date.now() - 1_000) } },
    );

    await expect(
      repository.heartbeat(
        created.jobId,
        claimed!.version,
        raw.attemptEpoch,
        String(raw.fencingToken),
        workerId,
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
    expect((await repository.getRaw(created.jobId, context)).status).toBe('leased');
  });

  it('L1-B13-A-TRAIN-002-S04 keeps every queued retry dispatchable without a stable Outbox collision', async () => {
    const workerId = `repeat-retry-${suffix}`;
    const created = await createIndexJob('repeat-retry');
    const models = registerKnowledgeModels(connection);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const claimed = await repository.claimById(
        { jobId: created.jobId, kinds: ['index'], workerId },
        context,
      );
      const raw = await repository.getRaw(created.jobId, context);
      const started = await repository.start(
        created.jobId,
        claimed!.version,
        raw.attemptEpoch,
        String(raw.fencingToken),
        workerId,
        context,
      );
      const failed = await repository.fail(
        created.jobId,
        started.version,
        raw.attemptEpoch,
        String(raw.fencingToken),
        workerId,
        true,
        'KNOWLEDGE_DEPENDENCY_TIMEOUT',
        context,
        { attempt },
      );
      expect(failed.status).toBe('retry_wait');
      expect(failed.attempts).toBe(attempt);
      await models.KnowledgeJob.updateOne(
        { _id: created.jobId, workspaceId },
        { $set: { availableAt: new Date(Date.now() - 1_000) } },
      );
      await expect(repository.requeueDueRetries(context)).resolves.toBe(1);
      expect((await repository.getRaw(created.jobId, context)).status).toBe('queued');
    }

    const retryEvents = await models.KnowledgeOutboxEvent.find({
      workspaceId,
      aggregateId: created.jobId,
      eventType: 'index.job.retry',
    }).lean();
    expect(retryEvents).toHaveLength(2);
  });
});
