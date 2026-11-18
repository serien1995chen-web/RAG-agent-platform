import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { KnowledgeJobExecutionRepository } from '../../packages/service/src/modules/knowledge/repository/job-execution.repository';
import { KnowledgeOutboxDispatcher } from '../../packages/service/src/shared/persistence/knowledge/outbox';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import type { KnowledgeQueueName } from '../../packages/dal/src/job-contract';
import type { QueuePort } from '../../packages/dal/src/queue-port';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const runId = process.env.CODEXB_RUN_ID ?? `b13b-fault-${Date.now()}`;
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_b13b_fault_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `b13b_member_${suffix}`,
  requestId: `b13b_request_${suffix}`,
  traceId: runId
    .replace(/[^a-z0-9]/gi, '')
    .padEnd(32, '0')
    .slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
  isWorkspaceOwner: true,
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let repository: KnowledgeJobExecutionRepository;

async function createJob(key: string) {
  return repository.create(
    {
      kind: 'index',
      resourceType: 'segment',
      resourceId: randomUUID().replaceAll('-', '').slice(0, 24),
      knowledgeSpaceId: randomUUID().replaceAll('-', '').slice(0, 24),
      inputSnapshot: { segmentVersion: 1, runId },
      priority: 5,
      idempotencyKey: `b13b-fault-${suffix}-${key}`,
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
  }
  await connection.close();
});

describe('B13B retry and pause recovery faults', () => {
  it('L1-B13-B-TRAIN-005-F01 Outbox publish failure retries without duplicating the Mongo Job', async () => {
    const job = await createJob('outbox');
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeJob.updateOne(
      { _id: job.jobId, workspaceId },
      {
        $set: { status: 'failed', error: { code: 'KNOWLEDGE_MODEL_FAILED' } },
        $inc: { version: 1 },
      },
    );
    const failed = await repository.getRaw(job.jobId, context);
    await repository.control('retry', job.jobId, failed.version, context);
    const event = await models.KnowledgeOutboxEvent.findOne({
      workspaceId,
      aggregateId: job.jobId,
      eventType: 'index.job.requeued',
    }).lean();
    if (!event) throw new Error('Expected requeue Outbox event');
    await models.KnowledgeOutboxEvent.updateMany(
      { workspaceId, _id: { $ne: event._id }, status: 'pending' },
      { $set: { status: 'published', publishedAt: new Date() }, $inc: { version: 1 } },
    );

    const enqueued: string[] = [];
    let failFirst = true;
    const queue: QueuePort = {
      async enqueue(_queue: KnowledgeQueueName, jobId: string) {
        enqueued.push(jobId);
        if (failFirst) {
          failFirst = false;
          throw new Error('redis temporarily unavailable');
        }
        return { jobId, enqueued: true };
      },
      async remove() {},
      async close() {},
    };
    const dispatcher = new KnowledgeOutboxDispatcher(connection, queue);
    expect(await dispatcher.dispatchOnce(context)).toMatchObject({ dispatched: false });
    const failedEvent = await models.KnowledgeOutboxEvent.findOne({
      _id: event._id,
      workspaceId,
    }).lean();
    expect(failedEvent).toMatchObject({
      status: 'failed',
      error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' },
    });
    await models.KnowledgeOutboxEvent.updateOne(
      { _id: event._id, workspaceId },
      { $set: { availableAt: new Date(Date.now() - 1_000) } },
    );
    expect(await dispatcher.dispatchOnce(context)).toMatchObject({ dispatched: true });
    expect(enqueued).toHaveLength(2);
    expect(
      await models.KnowledgeJob.countDocuments({
        workspaceId,
        _id: job.jobId,
      }),
    ).toBe(1);
    expect(
      await models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateId: job.jobId,
        eventType: 'index.job.requeued',
      }),
    ).toBe(1);
  });

  it('L1-B13-B-TRAIN-007-F01 paused work survives lease recovery and is not requeued', async () => {
    const job = await createJob('paused-recovery');
    const claimed = await repository.claimById(
      { jobId: job.jobId, kinds: ['index'], workerId: `b13b-worker-${suffix}` },
      context,
    );
    if (!claimed) throw new Error('Expected claimed Job');
    const raw = await repository.getRaw(job.jobId, context);
    const running = await repository.start(
      job.jobId,
      claimed.version,
      raw.attemptEpoch,
      raw.fencingToken,
      `b13b-worker-${suffix}`,
      context,
    );
    const paused = await repository.control('pause', job.jobId, running.version, context);
    expect(paused.status).toBe('paused');
    expect(await repository.recoverExpiredLeases(context)).toBe(0);
    expect(await repository.requeueDueRetries(context)).toBe(0);
    expect((await repository.getRaw(job.jobId, context)).status).toBe('paused');
  });

  it('L1-B13-B-TRAIN-007-F02 cancelled work cannot be recovered into a new execution', async () => {
    const job = await createJob('cancelled-recovery');
    const cancelled = await repository.control('cancel', job.jobId, job.version, context);
    expect(cancelled.status).toBe('cancelled');
    expect(await repository.recoverExpiredLeases(context)).toBe(0);
    expect(await repository.requeueDueRetries(context)).toBe(0);
    expect((await repository.getRaw(job.jobId, context)).status).toBe('cancelled');
  });
});
