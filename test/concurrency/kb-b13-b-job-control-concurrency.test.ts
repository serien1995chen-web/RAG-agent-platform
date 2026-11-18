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

const runId = process.env.CODEXB_RUN_ID ?? `b13b-concurrency-${Date.now()}`;
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_b13b_concurrency_${suffix}`;
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

async function createRunningJob(key: string) {
  const job = await repository.create(
    {
      kind: 'index',
      resourceType: 'segment',
      resourceId: randomUUID().replaceAll('-', '').slice(0, 24),
      knowledgeSpaceId: randomUUID().replaceAll('-', '').slice(0, 24),
      inputSnapshot: { segmentVersion: 1, runId },
      priority: 5,
      idempotencyKey: `b13b-concurrency-${suffix}-${key}`,
    },
    context,
  );
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
  return { job, raw, running };
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

describe('B13B Job control concurrency', () => {
  it('L1-B13-B-TRAIN-005-C01 cancel versus complete allows one committed transition', async () => {
    const { job, raw, running } = await createRunningJob('cancel-complete');
    const outcomes = await Promise.allSettled([
      repository.control('cancel', job.jobId, running.version, context),
      repository.commit(
        job.jobId,
        running.version,
        raw.attemptEpoch,
        raw.fencingToken,
        `b13b-worker-${suffix}`,
        { committedBy: 'concurrent-complete' },
        context,
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const final = await repository.getRaw(job.jobId, context);
    expect(['cancelling', 'cancelled', 'succeeded']).toContain(final.status);
    const result = final.result as Record<string, unknown> | null;
    if (final.status === 'cancelling' || final.status === 'cancelled') {
      expect(result?.committedBy).toBeUndefined();
    }
  });

  it('L1-B13-B-TRAIN-007-C01 pause versus complete allows only one winner', async () => {
    const { job, raw, running } = await createRunningJob('pause-complete');
    const outcomes = await Promise.allSettled([
      repository.control('pause', job.jobId, running.version, context),
      repository.commit(
        job.jobId,
        running.version,
        raw.attemptEpoch,
        raw.fencingToken,
        `b13b-worker-${suffix}`,
        { committedBy: 'pause-race-complete' },
        context,
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const final = await repository.getRaw(job.jobId, context);
    expect(['paused', 'succeeded']).toContain(final.status);
    if (final.status === 'paused') {
      expect((final.result as Record<string, unknown> | null)?.committedBy).toBeUndefined();
    }
  });

  it('L1-B13-B-TRAIN-007-C02 two resumes at one version allow exactly one execution opportunity', async () => {
    const job = await repository.create(
      {
        kind: 'index',
        resourceType: 'segment',
        resourceId: randomUUID().replaceAll('-', '').slice(0, 24),
        knowledgeSpaceId: randomUUID().replaceAll('-', '').slice(0, 24),
        inputSnapshot: { segmentVersion: 1, runId },
        priority: 5,
        idempotencyKey: `b13b-concurrency-${suffix}-resume`,
      },
      context,
    );
    const paused = await repository.control('pause', job.jobId, job.version, context);
    const outcomes = await Promise.allSettled([
      repository.control('resume', job.jobId, paused.version, context),
      repository.control('resume', job.jobId, paused.version, context),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect((await repository.getRaw(job.jobId, context)).status).toBe('queued');
    expect(
      await connection.models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateId: job.jobId,
        eventType: 'index.job.requeued',
      }),
    ).toBe(1);
  });

  it('L1-B13-B-TRAIN-005-C03 replay advances the fence and rejects the old worker', async () => {
    const { job, raw } = await createRunningJob('replay-stale');
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeJob.updateOne(
      { _id: job.jobId, workspaceId },
      {
        $set: {
          status: 'dead_letter',
          leaseOwner: null,
          leaseExpiresAt: null,
          error: { code: 'KNOWLEDGE_JOB_FAILED', retryable: false },
        },
        $inc: { version: 1 },
      },
    );
    const dead = await repository.getRaw(job.jobId, context);
    const replayed = await repository.control('replay', job.jobId, dead.version, context);
    expect(replayed.status).toBe('queued');
    expect(replayed.attemptEpoch).toBeGreaterThan(dead.attemptEpoch);
    await expect(
      repository.commit(
        job.jobId,
        raw.version,
        raw.attemptEpoch,
        raw.fencingToken,
        `b13b-worker-${suffix}`,
        { stale: true },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
  });
});
