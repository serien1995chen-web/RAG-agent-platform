import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
} from '../../src/shared/persistence/schemas/knowledge-index';
import { KnowledgeArchiveRepository } from '../../src/modules/knowledge/repository/archive.repository';
import { KnowledgeJobExecutionRepository } from '../../src/modules/knowledge/repository/job-execution.repository';
import { createKnowledgeMongoConnection } from '../../src/shared/runtime/knowledge-connections';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const runId = process.env.CODEXB_RUN_ID ?? `b13b-local-${Date.now()}`;
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_b13b_integration_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `b13b_member_${suffix}`,
  requestId: `b13b_request_${suffix}`,
  traceId: runId
    .replace(/[^a-z0-9]/gi, '')
    .padEnd(32, '0')
    .slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: true,
};

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let execution: KnowledgeJobExecutionRepository;
let jobs: KnowledgeArchiveRepository;

async function createJob(key: string) {
  return execution.create(
    {
      kind: 'index',
      resourceType: 'segment',
      resourceId: randomUUID().replaceAll('-', '').slice(0, 24),
      knowledgeSpaceId: randomUUID().replaceAll('-', '').slice(0, 24),
      inputSnapshot: { segmentVersion: 1, runId },
      priority: 5,
      idempotencyKey: `b13b-${suffix}-${key}`,
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
  execution = new KnowledgeJobExecutionRepository(connection);
  jobs = new KnowledgeArchiveRepository(connection);
}, 60_000);

afterAll(async () => {
  if (!connection) return;
  for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
    await connection.models[entry.modelName]?.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('B13B Job control integration', () => {
  it('L1-B13-B-TRAIN-005-P01 Job detail exposes attempts progress and Step errors', async () => {
    const job = await createJob('detail');
    await execution.setStep(
      {
        jobId: job.jobId,
        stepKey: 'embed',
        status: 'failed',
        idempotencyKey: `b13b-step-${job.jobId}`,
        evidence: { attemptEpoch: job.attemptEpoch, runId },
        error: { code: 'KNOWLEDGE_MODEL_FAILED', retryable: true },
      },
      context,
    );
    await connection.models.KnowledgeJob.updateOne(
      { _id: job.jobId, workspaceId },
      {
        $set: {
          status: 'failed',
          attempts: 2,
          progress: { stage: 'embed', completed: 1, total: 2, percent: 50 },
          error: { code: 'KNOWLEDGE_MODEL_FAILED', retryable: true },
        },
      },
    );

    const detail = await jobs.get(job.jobId, context);
    expect(detail).toMatchObject({
      jobId: job.jobId,
      status: 'failed',
      attempts: 2,
      maxAttempts: 3,
      progress: { stage: 'embed', completed: 1, total: 2, percent: 50 },
      error: { code: 'KNOWLEDGE_MODEL_FAILED', retryable: true },
    });
    expect(detail.steps).toEqual([
      expect.objectContaining({
        stepKey: 'embed',
        status: 'failed',
        attempts: 1,
        error: { code: 'KNOWLEDGE_MODEL_FAILED', retryable: true },
      }),
    ]);
  });

  it('L1-B13-B-TRAIN-005-S01 retry creates one requeue event and clears Job and Step errors', async () => {
    const job = await createJob('retry');
    const claimed = await execution.claimById(
      { jobId: job.jobId, kinds: ['index'], workerId: `b13b-worker-${suffix}` },
      context,
    );
    if (!claimed) throw new Error('Expected claimed Job');
    const raw = await execution.getRaw(job.jobId, context);
    const running = await execution.start(
      job.jobId,
      claimed.version,
      raw.attemptEpoch,
      raw.fencingToken,
      `b13b-worker-${suffix}`,
      context,
    );
    await execution.setStep(
      {
        jobId: job.jobId,
        stepKey: 'embed',
        status: 'failed',
        idempotencyKey: `b13b-retry-step-${job.jobId}`,
        error: { code: 'KNOWLEDGE_MODEL_FAILED' },
      },
      context,
    );
    const failed = await execution.fail(
      job.jobId,
      running.version,
      raw.attemptEpoch,
      raw.fencingToken,
      `b13b-worker-${suffix}`,
      false,
      'KNOWLEDGE_MODEL_FAILED',
      context,
    );
    expect(failed.status).toBe('failed');

    const retried = await execution.control('retry', job.jobId, failed.version, context);
    expect(retried).toMatchObject({ status: 'queued', error: null, attempts: 0 });
    expect(retried.attemptEpoch).toBeGreaterThan(failed.attemptEpoch);
    expect(
      await connection.models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateId: job.jobId,
        eventType: 'index.job.requeued',
      }),
    ).toBe(1);
    expect(
      await connection.models.KnowledgeJobStep.findOne({
        workspaceId,
        jobId: job.jobId,
        stepKey: 'embed',
      }).lean(),
    ).toMatchObject({ status: 'pending', error: null });
  });

  it('L1-B13-B-TRAIN-007-S01 resume creates a new execution epoch from the safe point', async () => {
    const job = await createJob('pause-resume');
    await execution.setStep(
      {
        jobId: job.jobId,
        stepKey: 'chunk',
        status: 'succeeded',
        idempotencyKey: `b13b-pause-step-${job.jobId}`,
        evidence: { safePoint: true },
      },
      context,
    );
    const paused = await execution.control('pause', job.jobId, job.version, context);
    expect(paused).toMatchObject({ status: 'paused' });
    expect(paused.pausedAt).toEqual(expect.any(String));
    const resumed = await execution.control('resume', job.jobId, paused.version, context);
    expect(resumed).toMatchObject({ status: 'queued', pausedAt: null, error: null });
    expect(resumed.attemptEpoch).toBeGreaterThan(paused.attemptEpoch);
    expect(
      await connection.models.KnowledgeJobStep.countDocuments({
        workspaceId,
        jobId: job.jobId,
        stepKey: 'chunk',
      }),
    ).toBe(1);
  });

  it('L1-B13-B-TRAIN-005-N01 unknown Job is 404 and stale or illegal control is 409', async () => {
    await expect(
      execution.control('cancel', randomUUID().replaceAll('-', '').slice(0, 24), 1, context),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });

    const job = await createJob('stale-control');
    await expect(
      execution.control('pause', job.jobId, job.version + 1, context),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });

    await connection.models.KnowledgeJob.updateOne(
      { _id: job.jobId, workspaceId },
      { $set: { status: 'succeeded' }, $inc: { version: 1 } },
    );
    const terminal = await execution.getRaw(job.jobId, context);
    await expect(
      execution.control('cancel', job.jobId, terminal.version, context),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
  });

  it('L1-B13-B-TRAIN-005-S02 cancelled queued work cannot be committed by a stale worker', async () => {
    const job = await createJob('cancel');
    const cancelled = await execution.control('cancel', job.jobId, job.version, context);
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(cancelled.cancelRequestedAt).toEqual(expect.any(String));
    await expect(
      execution.commit(
        job.jobId,
        job.version,
        job.attemptEpoch,
        'stale-token',
        `b13b-worker-${suffix}`,
        { sideEffects: 1 },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    expect((await execution.getRaw(job.jobId, context)).result).toBeNull();
  });

  it('L1-B13-B-TRAIN-005-Q01 list filtering is bounded and keeps tenant counts exact', async () => {
    for (const key of ['q01-a', 'q01-b', 'q01-c']) await createJob(key);
    const page = await jobs.list({ limit: '2', kind: 'index', status: 'queued' }, context);
    expect(page.items).toHaveLength(2);
    expect(page.pageInfo.hasMore).toBe(true);
    expect(page.items.every((item) => item.kind === 'index' && item.status === 'queued')).toBe(
      true,
    );
    expect(
      await connection.models.KnowledgeJob.countDocuments({
        workspaceId,
        kind: 'index',
        status: 'queued',
      }),
    ).toBeGreaterThanOrEqual(3);
    const unknown = await execution
      .control('cancel', randomUUID().replaceAll('-', '').slice(0, 24), 1, context)
      .catch((error: unknown) => error);
    expect(JSON.stringify(unknown)).not.toMatch(/stack|at\s+\w+\s+\(/);
  });
});
