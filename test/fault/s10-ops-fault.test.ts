import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeError } from '../../packages/contracts/src';
import { S10OpsWorkerApplication } from '../../packages/service/src/modules/knowledge/application/s10-ops-worker.application';
import { S10StatusApplication } from '../../packages/service/src/modules/knowledge/application/s10-status.application';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_fault',
  memberId: 'member_fault',
  requestId: 'request_fault',
  traceId: 'trace_fault',
  scopes: ['knowledge:admin'],
  isWorkspaceOwner: true,
};

describe('TEST-S10-NO-FAKE-COMPLETE status probe failure', () => {
  it('returns degraded with unknown verification when the probe adapter fails', async () => {
    const app = new S10StatusApplication({
      async probe() {
        throw new Error('dependency probe crashed');
      },
    });
    const status = await app.get(context);
    expect(status.status).toBe('degraded');
    expect(status.dependencies.mongo).toMatchObject({
      status: 'down',
      verificationStatus: 'UNKNOWN',
    });
    expect(status.modelProbe.verificationStatus).toBe('UNKNOWN');
    expect(status.reconciliation.state).toBe('unknown');
  });
});

describe('TEST-X-PGVECTOR-PARTIAL', () => {
  it('keeps partial vector repair retryable and never commits success', async () => {
    const commit = vi.fn(async () => ({ status: 'succeeded', result: {} }));
    const fail = vi.fn(async () => undefined);
    const setStep = vi.fn(async () => undefined);
    const worker = new S10OpsWorkerApplication({
      jobs: {
        claimById: async () => ({}),
        getRaw: async () => ({
          version: 1,
          kind: 'reconcile',
          inputSnapshot: { scope: 'vectors', repair: true },
          fencingToken: 'fence',
          attemptEpoch: 1,
        }),
        start: async () => ({ version: 2 }),
        setStep,
        commit,
        fail,
      },
      async cleanup() {
        throw new Error('not used');
      },
      async reconcile({ step }) {
        await step('vectors:768', 'succeeded', { batchKey: 'vectors', written: 768 });
        await step('vectors:1024', 'succeeded', { batchKey: 'vectors', written: 1024 });
        await step('vectors:1536', 'failed', {
          batchKey: 'vectors',
          errorCode: 'PGVECTOR_PARTIAL_WRITE',
          written: 1536,
        });
        throw createKnowledgeError({
          code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
          requestId: context.requestId,
          traceId: context.traceId,
          retryable: true,
          details: { dependency: 'pgvector', reason: 'partial_write' },
        });
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
          details: { dependency: 'pgvector', reason: 'partial_write' },
        },
      },
    });
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
    expect(commit).not.toHaveBeenCalled();
    expect(setStep).toHaveBeenCalledWith(
      expect.objectContaining({
        stepKey: 'vectors:1536',
        status: 'failed',
        evidence: expect.objectContaining({ errorCode: 'PGVECTOR_PARTIAL_WRITE' }),
      }),
      context,
    );
  });
});
