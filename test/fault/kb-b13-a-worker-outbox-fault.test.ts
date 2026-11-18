import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BullMqQueueAdapter } from '../../packages/dal/src/index';
import type { QueuePort } from '../../packages/dal/src/queue-port';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { KnowledgeJobExecutionRepository } from '../../packages/service/src/modules/knowledge/repository/job-execution.repository';
import { KnowledgeOutboxDispatcher } from '../../packages/service/src/shared/persistence/knowledge/outbox';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

function objectId() {
  return randomUUID().replaceAll('-', '').slice(0, 24);
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b13a_fault_${suffix}`;
const knowledgeSpaceId = objectId();
const context: TenantContext = {
  workspaceId,
  memberId: `b13a_fault_mem_${suffix}`,
  requestId: `b13a_fault_req_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
};

let connection: ReturnType<typeof createKnowledgeMongoConnection>;
let repository: KnowledgeJobExecutionRepository;
let queueAdapter: BullMqQueueAdapter;
const redisPrefix = `kb-b13a-outbox-${suffix}`;
const deliveredJobIds: string[] = [];

function queue(work: () => Promise<void>) {
  return {
    async enqueue() {
      await work();
      return { enqueued: true };
    },
    async remove() {
      return;
    },
    async close() {
      return;
    },
  } as unknown as QueuePort;
}

async function createJob(key: string) {
  return repository.create(
    {
      kind: 'index',
      resourceType: 'segment',
      resourceId: objectId(),
      knowledgeSpaceId,
      inputSnapshot: { segmentVersion: 1, modelId: 'mock-embedding-1024' },
      priority: 5,
      idempotencyKey: `b13a-fault-${suffix}-${key}`,
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
  const redisUrl = new URL(requiredEnv('KB_TEST_REDIS_URL'));
  queueAdapter = new BullMqQueueAdapter({
    connection: {
      host: redisUrl.hostname,
      port: Number(redisUrl.port || 6379),
      db: Number(redisUrl.pathname.replace('/', '') || 0),
    },
    prefix: redisPrefix,
  });
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({ workspaceId });
  }
  for (const jobId of deliveredJobIds) {
    await queueAdapter?.remove('knowledge-index', jobId).catch(() => undefined);
  }
  await queueAdapter?.close();
  await connection.close();
});

describe('B13-A Outbox and worker fault recovery', () => {
  it('TEST-X-OUTBOX-CRASH L1-B13-A-TRAIN-001-F01 recovers a failed publish and delivers exactly once', async () => {
    const created = await createJob('outbox');
    const models = registerKnowledgeModels(connection);
    let enqueues = 0;
    const failing = new KnowledgeOutboxDispatcher(
      connection,
      queue(async () => {
        throw new Error('redis unavailable');
      }),
    );
    await expect(failing.dispatchOnce(context)).resolves.toMatchObject({ dispatched: false });
    let event = await models.KnowledgeOutboxEvent.findOne({
      workspaceId,
      aggregateId: created.jobId,
    }).lean();
    expect(event?.status).toBe('failed');
    expect(event?.attempts).toBe(1);

    await models.KnowledgeOutboxEvent.updateOne(
      { _id: event!._id, workspaceId },
      { $set: { availableAt: new Date(Date.now() - 1_000) } },
    );
    const recovering = new KnowledgeOutboxDispatcher(
      connection,
      queue(async () => {
        enqueues += 1;
      }),
    );
    await expect(recovering.dispatchOnce(context)).resolves.toMatchObject({ dispatched: true });
    await expect(recovering.dispatchOnce(context)).resolves.toMatchObject({ dispatched: false });
    expect(enqueues).toBe(1);
    event = await models.KnowledgeOutboxEvent.findOne({
      workspaceId,
      aggregateId: created.jobId,
    }).lean();
    expect(event?.status).toBe('published');
    expect(event?.attempts).toBe(2);
  });

  it('TEST-X-OUTBOX-CRASH L1-B13-A-TRAIN-001-F02 recovers stale publishing without duplicate delivery', async () => {
    const created = await createJob('stale-publish');
    const models = registerKnowledgeModels(connection);
    const event = await models.KnowledgeOutboxEvent.findOne({
      workspaceId,
      aggregateId: created.jobId,
    });
    expect(event).not.toBeNull();
    await models.KnowledgeOutboxEvent.updateOne(
      { _id: event!._id, workspaceId },
      {
        $set: {
          status: 'publishing',
          updatedAt: new Date(Date.now() - 60_000),
        },
      },
      { timestamps: false },
    );
    let enqueues = 0;
    const dispatcher = new KnowledgeOutboxDispatcher(
      connection,
      queue(async () => {
        enqueues += 1;
      }),
    );
    await expect(dispatcher.dispatchOnce(context)).resolves.toMatchObject({ dispatched: true });
    await expect(dispatcher.dispatchOnce(context)).resolves.toMatchObject({ dispatched: false });
    expect(enqueues).toBe(1);
  });

  it('TEST-X-OUTBOX-CRASH L1-B13-A-TRAIN-001-F03 does not enqueue a second BullMQ delivery after an interrupted published update', async () => {
    const created = await createJob('enqueue-before-publish-crash');
    const models = registerKnowledgeModels(connection);
    const queuePort = {
      enqueue: async (queue, jobId, payload, options) => {
        const result = await queueAdapter.enqueue(queue, jobId, payload, options);
        if (result.enqueued) deliveredJobIds.push(jobId);
        return result;
      },
      remove: queueAdapter.remove.bind(queueAdapter),
      close: queueAdapter.close.bind(queueAdapter),
    };
    const dispatcher = new KnowledgeOutboxDispatcher(connection, queuePort);
    const update = vi
      .spyOn(models.KnowledgeOutboxEvent, 'updateOne')
      .mockRejectedValue(new Error('process interrupted after enqueue'));

    await expect(dispatcher.dispatchOnce(context)).rejects.toThrow('process interrupted');
    update.mockRestore();

    const interrupted = await models.KnowledgeOutboxEvent.findOne({
      workspaceId,
      aggregateId: created.jobId,
    }).lean();
    expect(interrupted).toMatchObject({ status: 'publishing', attempts: 1 });
    await models.KnowledgeOutboxEvent.updateOne(
      { _id: interrupted!._id, workspaceId },
      { $set: { updatedAt: new Date(Date.now() - 60_000) } },
      { timestamps: false },
    );

    await expect(dispatcher.dispatchOnce(context)).resolves.toMatchObject({ dispatched: true });
    expect(deliveredJobIds).toHaveLength(1);
  });

  it('L1-B13-A-TRAIN-002-F01 recovers a killed running worker and rejects its stale commit', async () => {
    const created = await createJob('killed');
    const claimed = await repository.claimById(
      { jobId: created.jobId, kinds: ['index'], workerId: `killed-${suffix}` },
      context,
    );
    const raw = await repository.getRaw(created.jobId, context);
    const fence = String(raw.fencingToken);
    const started = await repository.start(
      created.jobId,
      claimed!.version,
      raw.attemptEpoch,
      fence,
      `killed-${suffix}`,
      context,
    );
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeJob.updateOne(
      { _id: created.jobId, workspaceId },
      { $set: { leaseExpiresAt: new Date(Date.now() - 1_000) } },
    );
    expect(await repository.recoverExpiredLeases(context)).toBe(1);
    const recovered = await repository.getRaw(created.jobId, context);
    expect(recovered.status).toBe('retry_wait');
    expect(recovered.attemptEpoch).toBe(1);
    await expect(
      repository.commit(
        created.jobId,
        started.version,
        raw.attemptEpoch,
        fence,
        `killed-${suffix}`,
        { stale: true },
        context,
      ),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_CONFLICT' } } });
    await models.KnowledgeJob.updateOne(
      { _id: created.jobId, workspaceId },
      { $set: { availableAt: new Date(Date.now() - 1_000) } },
    );
    expect(await repository.requeueDueRetries(context)).toBe(1);
    const requeued = await repository.getRaw(created.jobId, context);
    expect(requeued.status).toBe('queued');
    expect(requeued.attempts).toBe(1);
    expect(requeued.attemptEpoch).toBe(1);
  });
});
