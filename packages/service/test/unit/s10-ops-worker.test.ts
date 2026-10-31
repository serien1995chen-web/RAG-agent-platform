import { createKnowledgeError } from '@kb/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  S10OpsWorkerApplication,
  type S10WorkerJobPort,
} from '../../src/modules/knowledge/application/s10-ops-worker.application';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_worker',
  memberId: 'worker-member',
  requestId: 'worker-request',
  traceId: 'worker-trace',
  scopes: ['knowledge:admin'],
  isWorkspaceOwner: false,
};

function jobPort(
  kind: 'cleanup' | 'reconcile' | 'outbox' = 'cleanup',
  inputSnapshot: Record<string, unknown> = { scope: 'all', repair: false },
) {
  const commit = vi.fn(async () => ({ status: 'succeeded', result: { diffCount: 1 } }));
  const fail = vi.fn(async () => undefined);
  const setStep = vi.fn(async () => undefined);
  const port: S10WorkerJobPort = {
    claimById: async () => ({}),
    getRaw: async () => ({
      version: 1,
      kind,
      inputSnapshot,
      fencingToken: 'fence',
      attemptEpoch: 1,
    }),
    start: async () => ({ version: 2 }),
    setStep,
    commit,
    fail,
  };
  return { port, commit, fail, setStep };
}

const result = {
  diffCount: 1,
  repairedCount: 1,
  retryable: 0,
  deadLetter: 0,
  items: [{ id: 'safe' }],
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
};

describe('S10 ops worker evidence', () => {
  it('routes usage outbox events through the configured delivery adapter', async () => {
    const { port } = jobPort('outbox');
    const deliverUsage = vi.fn(async () => undefined);
    const worker = new S10OpsWorkerApplication({
      jobs: port,
      deliverUsage,
      async cleanup() {
        throw new Error('not used');
      },
      async reconcile() {
        throw new Error('not used');
      },
      async replay() {
        throw new Error('not used');
      },
    });
    await worker.handleUsageOutbox({
      outboxEventId: 'outbox',
      payload: { usageEventId: 'usage-event', pointsMicros: 1 },
      attempt: 1,
      maxAttempts: 10,
      context,
    });
    expect(deliverUsage).toHaveBeenCalledWith({
      outboxEventId: 'outbox',
      eventId: 'usage-event',
      payload: { usageEventId: 'usage-event', pointsMicros: 1 },
      context,
    });
  });

  it('marks the target outbox dead-letter only on the final usage delivery attempt', async () => {
    const { port } = jobPort('outbox');
    const markUsageOutboxFailed = vi.fn(async () => undefined);
    const deliverUsage = vi.fn(async () => {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId: context.requestId,
        traceId: context.traceId,
        retryable: true,
      });
    });
    const worker = new S10OpsWorkerApplication({
      jobs: port,
      deliverUsage,
      markUsageOutboxFailed,
      async cleanup() {
        throw new Error('not used');
      },
      async reconcile() {
        throw new Error('not used');
      },
      async replay() {
        throw new Error('not used');
      },
    });
    const input = {
      outboxEventId: 'outbox',
      payload: { usageEventId: 'usage-event' },
      context,
    };
    await expect(
      worker.handleUsageOutbox({ ...input, attempt: 9, maxAttempts: 10 }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' } } });
    expect(markUsageOutboxFailed).not.toHaveBeenCalled();
    await expect(
      worker.handleUsageOutbox({ ...input, attempt: 10, maxAttempts: 10 }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' } } });
    expect(markUsageOutboxFailed).toHaveBeenCalledWith({
      outboxEventId: 'outbox',
      eventId: 'usage-event',
      errorCode: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
      deadLetter: true,
      context,
    });
  });

  it('dispatches the outbox event recorded on the replay Job', async () => {
    const { port } = jobPort('outbox', {
      scope: 'outbox',
      outboxEventId: 'event-target',
      outboxVersion: 7,
    });
    const replay = vi.fn(async () => ({
      diffCount: 1,
      repairedCount: 1,
      retryable: 0,
      deadLetter: 0,
      items: [{ eventKey: 'target' }],
    }));
    const worker = new S10OpsWorkerApplication({
      jobs: port,
      async cleanup() {
        throw new Error('not used');
      },
      async reconcile() {
        throw new Error('not used');
      },
      replay,
    });
    await worker.handleQueue('job', 'knowledge-outbox', 'worker', context);
    expect(replay).toHaveBeenCalledWith({
      jobId: 'job',
      eventId: 'event-target',
      expectedVersion: 7,
      context,
    });
  });

  it('commits cleanup steps and result through fencing tokens', async () => {
    const { port, commit, setStep } = jobPort();
    const worker = new S10OpsWorkerApplication({
      jobs: port,
      async cleanup({ step }) {
        await step('ttl_objects', 'succeeded', { scanned: 1 });
        return result;
      },
      async reconcile() {
        throw new Error('not used');
      },
      async replay() {
        throw new Error('not used');
      },
    });
    await expect(
      worker.handleQueue('job', 'knowledge-cleanup', 'worker', context),
    ).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(setStep).toHaveBeenCalled();
    expect(commit).toHaveBeenCalledWith(
      'job',
      2,
      1,
      'fence',
      'worker',
      expect.objectContaining({ diffCount: 1 }),
      context,
    );
  });

  it('writes retryable failure evidence and never fakes completion', async () => {
    const { port, commit, fail } = jobPort('reconcile');
    const worker = new S10OpsWorkerApplication({
      jobs: port,
      async cleanup() {
        throw new Error('not used');
      },
      async reconcile() {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
          requestId: context.requestId,
          traceId: context.traceId,
        });
      },
      async replay() {
        throw new Error('not used');
      },
    });
    await expect(
      worker.handleQueue('job', 'knowledge-cleanup', 'worker', context),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' } },
    });
    expect(commit).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      'job',
      2,
      1,
      'fence',
      'worker',
      true,
      'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
      context,
    );
  });

  it('never commits cleanup success when unresolved items remain', async () => {
    const { port, commit, fail } = jobPort();
    const worker = new S10OpsWorkerApplication({
      jobs: port,
      async cleanup() {
        return {
          ...result,
          retryable: 1,
          items: [{ id: 'retry-me' }],
        };
      },
      async reconcile() {
        throw new Error('not used');
      },
      async replay() {
        throw new Error('not used');
      },
    });
    await expect(
      worker.handleQueue('job', 'knowledge-cleanup', 'worker', context),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
          retryable: true,
          details: { reason: 'cleanup_unresolved_items' },
        },
      },
    });
    expect(commit).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      'job',
      2,
      1,
      'fence',
      'worker',
      true,
      'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
      context,
    );
  });
});
