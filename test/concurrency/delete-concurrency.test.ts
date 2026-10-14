import { ApiErrorException, createApiError } from '../../packages/contracts/src/index';
import { buildDeleteJobId } from '../../packages/dal/src/index';
import { DeleteApplicationService } from '../../packages/service/src/modules/delete/application/delete.service';
import { ReconcileApplicationService } from '../../packages/service/src/modules/delete/application/reconcile.service';
import type { RequestContext } from '../../packages/service/src/ports/types';
import { describe, expect, it } from 'vitest';

const context: RequestContext = {
  requestId: 'req-delete-concurrency',
  tenant: {
    teamId: '000000000000000000000001',
    tmbId: '000000000000000000000002',
    authType: 'internal',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const datasetId = '000000000000000000000101';
const jobId = buildDeleteJobId(context.tenant.teamId, datasetId);

function deleteService(options: { existingAfterTransaction?: boolean } = {}) {
  let jobVisible = false;
  let queueCalls = 0;
  let transactionCalls = 0;
  const service = new DeleteApplicationService({
    jobs: {
      async get() {
        if (!jobVisible) {
          throw new ApiErrorException(
            createApiError({
              code: 501070,
              requestId: context.requestId,
              params: { resourceType: 'job', resourceId: jobId },
            }),
          );
        }
        return {
          jobId,
          teamId: context.tenant.teamId,
          datasetId,
          state: 'completed',
          stage: 'verify',
          progress: 100,
          failureCount: 0,
          createTime: '2026-10-14T00:00:00.000Z',
          updateTime: '2026-10-14T00:00:00.000Z',
        };
      },
      async listFailures() {
        return { total: 0, list: [], cursor: null };
      },
      async retry() {
        return { accepted: false };
      },
      async transition() {
        return {
          jobId,
          teamId: context.tenant.teamId,
          datasetId,
          state: 'completed',
          stage: 'verify',
          progress: 100,
          failureCount: 0,
          createTime: '2026-10-14T00:00:00.000Z',
          updateTime: '2026-10-14T00:00:00.000Z',
        };
      },
      async claimWithLease() {
        return null;
      },
      async renewLease() {
        return true;
      },
      async releaseLease() {},
      async updateProgressGuarded() {
        return true;
      },
      async recordFailure() {},
      async resetRetry() {
        return true;
      },
    },
    crossStore: {
      async markStage() {
        return true;
      },
      async listByJob() {
        return [];
      },
      async resetNextAttempt() {
        return 0;
      },
    },
    facts: {
      async executeDeleteTransaction() {
        transactionCalls += 1;
        jobVisible = true;
        return {
          deleteJobId: jobId,
          datasetId,
          state: 'completed',
          existing: options.existingAfterTransaction ?? true,
          objectRefs: [],
          vectorDataIds: [],
        };
      },
      async listObjectRefsForScope() {
        return [];
      },
      async listVectorDataIds() {
        return [];
      },
      async hasLiveReference() {
        return false;
      },
    },
    queue: {
      async enqueue() {
        queueCalls += 1;
        return { jobId, enqueued: true };
      },
      async remove() {},
      async close() {},
    },
    vectorController: {
      async insert() {
        return { inserted: 0 };
      },
      async delete() {
        return { deleted: 0 };
      },
      async embRecall() {
        return [];
      },
      async getVectorDataByTime() {
        return [];
      },
      async getVectorCount() {
        return 0;
      },
    },
    objectStore: {
      async delete() {
        return { deleted: true };
      },
      async abort() {
        return { aborted: true };
      },
    } as never,
    syncSchedulerCleanup: async () => undefined,
  });
  return { service, stats: () => ({ transactionCalls, queueCalls }) };
}

describe('P6-07 concurrency batch', () => {
  it('TEST-REP-DELETE-001 repeated dataset delete yields one stable job and zero duplicate effects', async () => {
    const built = deleteService();
    const first = await built.service.requestDatasetDelete(
      { datasetId, options: { timeoutMs: 5_000 } },
      context,
    );
    const second = await built.service.requestDatasetDelete(
      { datasetId, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(first).toEqual({ jobId, state: 'completed' });
    expect(second).toEqual(first);
    expect(built.stats()).toEqual({ transactionCalls: 1, queueCalls: 0 });
  });

  it('ACC-DELETE-001/005 lease competition lets exactly one worker advance', async () => {
    let claimed = false;
    let completed = 0;
    const service = new DeleteApplicationService({
      jobs: {
        async get() {
          return {
            jobId,
            teamId: context.tenant.teamId,
            datasetId,
            state: 'deleting',
            stage: 'vector',
            progress: 0,
            failureCount: 0,
            createTime: '2026-10-14T00:00:00.000Z',
            updateTime: '2026-10-14T00:00:00.000Z',
          };
        },
        async listFailures() {
          return { total: 0, list: [], cursor: null };
        },
        async retry() {
          return { accepted: true };
        },
        async transition(input: { nextState: string }) {
          if (input.nextState === 'completed') completed += 1;
          return {
            jobId,
            teamId: context.tenant.teamId,
            datasetId,
            state: 'completed',
            stage: 'verify',
            progress: 100,
            failureCount: 0,
            createTime: '2026-10-14T00:00:00.000Z',
            updateTime: '2026-10-14T00:00:00.000Z',
          };
        },
        async claimWithLease() {
          if (claimed) return null;
          claimed = true;
          return {
            jobId,
            datasetId,
            state: 'deleting',
            stage: 'vector',
            attempt: 1,
            leaseOwner: 'owner-1',
          };
        },
        async renewLease() {
          return true;
        },
        async releaseLease() {},
        async updateProgressGuarded() {
          return true;
        },
        async recordFailure() {},
        async resetRetry() {
          return true;
        },
      },
      crossStore: {
        async markStage() {
          return true;
        },
        async listByJob() {
          return [];
        },
        async resetNextAttempt() {
          return 0;
        },
      },
      facts: {
        async executeDeleteTransaction() {
          throw new Error('not used');
        },
        async listObjectRefsForScope() {
          return [];
        },
        async listVectorDataIds() {
          return [];
        },
        async hasLiveReference() {
          return false;
        },
      },
      queue: {
        enqueue: async () => ({ jobId, enqueued: true }),
        remove: async () => undefined,
        close: async () => undefined,
      },
      vectorController: {
        insert: async () => ({ inserted: 0 }),
        delete: async () => ({ deleted: 0 }),
        embRecall: async () => [],
        getVectorDataByTime: async () => [],
        getVectorCount: async () => 0,
      },
      objectStore: {
        delete: async () => ({ deleted: true }),
        abort: async () => ({ aborted: true }),
      } as never,
      syncSchedulerCleanup: async () => undefined,
    });

    const results = await Promise.allSettled([
      service.runCleanup(
        { jobId, scope: { kind: 'dataset', datasetId }, options: { timeoutMs: 5_000 } },
        context,
      ),
      service.runCleanup(
        { jobId, scope: { kind: 'dataset', datasetId }, options: { timeoutMs: 5_000 } },
        context,
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { error: { code: 501068 } } });
    expect(completed).toBe(1);
  });

  it('ACC-RECON-002 repeated reconcile windows reuse deterministic dedup keys', async () => {
    const starts: string[] = [];
    const finishes: string[] = [];
    const service = new ReconcileApplicationService({
      facts: {
        scanVectorCandidates: async () => ({
          datasets: [],
          liveDataIds: [],
          liveDatasetIds: [],
          liveCollectionIds: [],
        }),
        scanFulltextCandidates: async () => [],
        scanAclOrphans: async () => [],
        scanTrainingOrphans: async () => [],
        scanStuckDeleteJobs: async () => [],
        scanFailedCrossStoreOps: async () => [],
        hasTtlRecord: async () => false,
        deleteAclRows: async () => 0,
        deleteTrainingRows: async () => 0,
        requeueStuckJob: async () => jobId,
      },
      reports: {
        async start(input: { dedupKey: string }) {
          starts.push(input.dedupKey);
        },
        async finish(input: { dedupKey: string }) {
          finishes.push(input.dedupKey);
          return true;
        },
        async listReports() {
          return { total: 0, list: [] };
        },
      },
      vectorController: {
        insert: async () => ({ inserted: 0 }),
        delete: async () => ({ deleted: 0 }),
        embRecall: async () => [],
        getVectorDataByTime: async () => [],
        getVectorCount: async () => 0,
      },
      clock: () => new Date('2026-10-14T12:00:00.000Z'),
    });
    const windowStart = new Date('2026-10-14T00:00:00.000Z');
    const windowEnd = new Date('2026-10-14T02:00:00.000Z');
    await service.run(
      { windowStart, windowEnd, scope: { kind: 'global' }, mode: 'dry-run' },
      context,
    );
    await service.run(
      { windowStart, windowEnd, scope: { kind: 'global' }, mode: 'dry-run' },
      context,
    );
    expect(starts).toHaveLength(16);
    expect(new Set(starts).size).toBe(8);
    expect(finishes).toHaveLength(16);
    expect(new Set(finishes).size).toBe(8);
  });
});
