import { ApiErrorException, createApiError } from '../../packages/contracts/src/index';
import { DeleteApplicationService } from '../../packages/service/src/modules/delete/application/delete.service';
import { CompensationApplicationService } from '../../packages/service/src/modules/delete/application/compensation.service';
import { ReconcileApplicationService } from '../../packages/service/src/modules/delete/application/reconcile.service';
import { S3TtlService } from '../../packages/service/src/modules/delete/application/s3-ttl.service';
import type { RequestContext } from '../../packages/service/src/ports/types';
import { describe, expect, it } from 'vitest';

const context: RequestContext = {
  requestId: 'req-delete-fault',
  tenant: {
    teamId: '000000000000000000000001',
    tmbId: '000000000000000000000002',
    authType: 'internal',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const datasetId = '000000000000000000000101';
const jobId = `${context.tenant.teamId}:${datasetId}:delete`;
const fixedNow = new Date('2026-10-14T12:00:00.000Z');

function retryableStorageError(requestId = context.requestId): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501016,
      requestId,
      params: { store: 'mongo', operation: 'mark_stage' },
    }),
  );
}

function objectStore(calls: string[], options: { failDelete?: boolean } = {}) {
  return {
    async abort() {
      return { aborted: true };
    },
    async delete(input: { ref: { key: string } }) {
      if (options.failDelete) throw new Error('delete failed');
      calls.push(input.ref.key);
      return { deleted: true };
    },
  } as never;
}

describe('P6-07 fault batch', () => {
  it('TEST-E2E-DELETE-001 interrupted delete worker can recover without real sleep', async () => {
    let attempt = 0;
    let completed = 0;
    let vectorCalls = 0;
    const service = new DeleteApplicationService({
      jobs: {
        get: async () => ({
          jobId,
          teamId: context.tenant.teamId,
          datasetId,
          state: 'deleting',
          stage: 'vector',
          progress: 0,
          failureCount: attempt > 0 ? 1 : 0,
          createTime: '2026-10-14T00:00:00.000Z',
          updateTime: '2026-10-14T00:00:00.000Z',
        }),
        listFailures: async () => ({ total: 0, list: [], cursor: null }),
        retry: async () => ({ accepted: true }),
        transition: async (input: { nextState: string }) => {
          if (input.nextState === 'completed') completed += 1;
          return {
            jobId,
            teamId: context.tenant.teamId,
            datasetId,
            state: input.nextState,
            stage: 'verify',
            progress: 100,
            failureCount: 0,
            createTime: '2026-10-14T00:00:00.000Z',
            updateTime: '2026-10-14T00:00:00.000Z',
          };
        },
        claimWithLease: async () => {
          attempt += 1;
          return {
            jobId,
            datasetId,
            state: 'deleting',
            stage: 'vector',
            attempt,
            leaseOwner: `owner-${attempt}`,
          };
        },
        renewLease: async () => true,
        releaseLease: async () => undefined,
        updateProgressGuarded: async () => true,
        recordFailure: async () => undefined,
        resetRetry: async () => true,
      },
      crossStore: {
        markStage: async () => true,
        listByJob: async () => [],
        resetNextAttempt: async () => 0,
      },
      facts: {
        executeDeleteTransaction: async () => {
          throw new Error('not used');
        },
        listObjectRefsForScope: async () => [],
        listVectorDataIds: async () => [],
        hasLiveReference: async () => false,
      },
      queue: {
        enqueue: async () => ({ jobId, enqueued: true }),
        remove: async () => undefined,
        close: async () => undefined,
      },
      vectorController: {
        insert: async () => ({ inserted: 0 }),
        delete: async () => {
          vectorCalls += 1;
          if (vectorCalls === 1) throw retryableStorageError();
          return { deleted: 1 };
        },
        embRecall: async () => [],
        getVectorDataByTime: async () => [],
        getVectorCount: async () => 0,
      },
      objectStore: objectStore([]),
      syncSchedulerCleanup: async () => undefined,
    });

    await expect(
      service.runCleanup(
        { jobId, scope: { kind: 'dataset', datasetId }, options: { timeoutMs: 5_000 } },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501016 } });
    await expect(
      service.runCleanup(
        { jobId, scope: { kind: 'dataset', datasetId }, options: { timeoutMs: 5_000 } },
        context,
      ),
    ).resolves.toEqual({ scanned: 0, deleted: 0, failed: 0, skipped: 0 });
    expect(completed).toBe(1);
  });

  it('TEST-FI-S3-001 / TEST-FI-MONGO-001 retries after S3 success and Mongo mark failure', async () => {
    const deleted: string[] = [];
    let cleaned = false;
    let markFailures = 0;
    const operation = {
      operationId: `delete-s3:${context.tenant.teamId}:temp-hash:1`,
      teamId: context.tenant.teamId,
      operation: 'delete_s3',
      stage: 'projection_pending',
      attempt: 0,
      resourceRef: {
        resourceType: 'object',
        resourceId: `temp/${context.tenant.teamId}/file.txt`,
        version: 1,
      },
      nextAttemptAt: new Date(fixedNow.getTime() - 1_000),
      leaseOwner: null,
      leaseExpireAt: null,
    };
    const service = new CompensationApplicationService({
      crossStore: {
        claimExpiredLease: async () => (cleaned ? [] : [operation]),
        markStage: async (input: { stage: string }) => {
          if (input.stage === 'cleaned') {
            markFailures += 1;
            if (markFailures === 1) {
              throw retryableStorageError();
            }
            cleaned = true;
            return true;
          }
          return true;
        },
        listByJob: async () => [operation],
        resetNextAttempt: async () => 1,
      },
      vectorController: {
        insert: async () => ({ inserted: 0 }),
        delete: async () => ({ deleted: 0 }),
        embRecall: async () => [],
        getVectorDataByTime: async () => [],
        getVectorCount: async () => 0,
      },
      objectStore: objectStore(deleted),
      hasFormalReference: async () => false,
      clock: () => fixedNow,
    });

    expect(await service.sweepOnce(context)).toEqual({
      scanned: 1,
      cleaned: 0,
      failed: 1,
      skipped: 0,
    });
    expect(deleted).toEqual([`temp/${context.tenant.teamId}/file.txt`]);
    expect(await service.sweepOnce(context)).toEqual({
      scanned: 1,
      cleaned: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it('TEST-RECON-TTL-001 applies fixed five-minute tolerance and exponential backoff', async () => {
    const record = {
      id: 'ttl-1',
      teamId: context.tenant.teamId,
      bucketName: 'kb-local',
      objectKey: `temp/${context.tenant.teamId}/expired.txt`,
      expireAt: new Date(fixedNow.getTime() - 10 * 60_000),
      attempt: 0,
      operationId: 'ttl-op-1',
      resourceRef: { resourceType: 'object', resourceId: 'expired.txt', version: 1 },
    };
    let nextAttemptAt: Date | undefined;
    const service = new S3TtlService({
      repository: {
        claimBatch: async ({ now }) =>
          nextAttemptAt === undefined || nextAttemptAt.getTime() <= now.getTime() ? [record] : [],
        markFailed: async (input) => {
          nextAttemptAt = input.nextAttemptAt;
          return true;
        },
        deleteRecord: async () => true,
        backfill: async () => undefined,
        hasFormalReference: async () => false,
        hasTtlRecord: async () => true,
        resolveDatasetTeamId: async () => context.tenant.teamId,
      },
      objectStore: objectStore([], { failDelete: true }),
      clock: () => fixedNow,
    });

    expect(await service.sweepOnce(context)).toEqual({
      scanned: 1,
      deleted: 0,
      failed: 1,
      skipped: 0,
    });
    expect(nextAttemptAt?.getTime()).toBe(fixedNow.getTime() + 60_000);
  });

  it('ACC-RECON-001/003 reports ACL orphan without deleting source references', async () => {
    const finishInputs: Array<{ findings: Array<{ kind: string; action: string }> }> = [];
    const service = new ReconcileApplicationService({
      facts: {
        scanVectorCandidates: async () => ({
          datasets: [],
          liveDataIds: [],
          liveDatasetIds: [],
          liveCollectionIds: [],
        }),
        scanFulltextCandidates: async () => [],
        scanAclOrphans: async () => [
          { id: 'acl-1', teamId: context.tenant.teamId, resourceId: datasetId },
        ],
        scanTrainingOrphans: async () => [],
        scanStuckDeleteJobs: async () => [],
        scanFailedCrossStoreOps: async () => [],
        hasTtlRecord: async () => true,
        deleteAclRows: async () => 0,
        deleteTrainingRows: async () => 0,
        requeueStuckJob: async () => jobId,
      },
      reports: {
        start: async () => undefined,
        finish: async (input) => {
          finishInputs.push(input);
          return true;
        },
        listReports: async () => ({ total: 0, list: [] }),
      },
      vectorController: {
        insert: async () => ({ inserted: 0 }),
        delete: async () => ({ deleted: 0 }),
        embRecall: async () => [],
        getVectorDataByTime: async () => [],
        getVectorCount: async () => 0,
      },
      clock: () => fixedNow,
    });
    await service.run(
      {
        windowStart: new Date(fixedNow.getTime() - 6 * 3_600_000),
        windowEnd: new Date(fixedNow.getTime() - 2 * 3_600_000),
        scope: { kind: 'global' },
        mode: 'dry-run',
      },
      context,
    );
    const acl = finishInputs.find((input) =>
      input.findings.some((finding) => finding.kind === 'acl-orphan'),
    );
    expect(acl?.findings).toEqual([
      expect.objectContaining({ kind: 'acl-orphan', action: 'report' }),
    ]);
  });
});
