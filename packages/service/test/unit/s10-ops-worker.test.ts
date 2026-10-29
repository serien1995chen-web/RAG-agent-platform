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

function jobPort(kind: 'cleanup' | 'reconcile' | 'outbox' = 'cleanup') {
  const commit = vi.fn(async () => ({ status: 'succeeded', result: { diffCount: 1 } }));
  const fail = vi.fn(async () => undefined);
  const setStep = vi.fn(async () => undefined);
  const port: S10WorkerJobPort = {
    claimById: async () => ({}),
    getRaw: async () => ({
      version: 1,
      kind,
      inputSnapshot: { scope: 'all', repair: false },
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
      context,
    });
    expect(deliverUsage).toHaveBeenCalledWith({
      outboxEventId: 'outbox',
      eventId: 'usage-event',
      payload: { usageEventId: 'usage-event', pointsMicros: 1 },
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
});
