import { describe, expect, it } from 'vitest';
import { ApiErrorException } from '../../packages/contracts/src/index';
import {
  MemoryIdempotencyStore,
  buildIdempotencyScopeKey,
  buildParseJobId,
  buildSyncJobId,
} from '../../packages/dal/src/index';
import { canRemoveOwner } from '../../packages/acl/src/index';
import { ProcessingApplicationService } from '../../packages/service/src/modules/processing/application';
import {
  PROCESSING_PERMANENT_LOCK_TIME,
  canClaim,
  manualRecoveryRetryCount,
} from '../../packages/service/src/modules/processing/domain/lease';
import type { RequestContext } from '../../packages/service/src/ports/types';

const context: RequestContext = {
  requestId: 'req-concurrency',
  tenant: { teamId: 'team-a', tmbId: 'tmb-a', authType: 'internal', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

describe('REP: idempotency and stable job ids', () => {
  it('lets exactly one concurrent identical request win', async () => {
    const store = new MemoryIdempotencyStore();
    const scope = buildIdempotencyScopeKey('team-a', 'POST', '/api/x', 'race-1');
    const results = await Promise.all([store.begin(scope, 'hash'), store.begin(scope, 'hash')]);
    expect(results.filter((result) => result.kind === 'started')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'conflict')).toHaveLength(1);
  });

  it('produces deterministic, collision-free job ids from scope inputs', () => {
    expect(buildParseJobId('t1', 'd1', 'c1', 1)).toBe(buildParseJobId('t1', 'd1', 'c1', 1));
    expect(buildParseJobId('t1', 'd1', 'c1', 1)).not.toBe(buildParseJobId('t1', 'd1', 'c1', 2));
  });

  it('keeps last-owner protection deterministic under repeated checks', () => {
    expect(canRemoveOwner(2, 1)).toBe(true);
    expect(canRemoveOwner(1, 1)).toBe(false);
    expect(canRemoveOwner(0, 1)).toBe(false);
  });

  it('lets only one worker claim a task and keeps sync job ids stable', async () => {
    let claimed = false;
    const repository = {
      enqueue: async () => ({ taskId: 'task-a', jobId: 'job-a' }),
      claim: async () => {
        if (claimed) {
          throw new ApiErrorException({
            code: 501005,
            statusText: 'dataset.task.invalid_state',
            messageKey: 'dataset.task.invalid_state',
            params: { taskId: 'task-a' },
            message: 'already claimed',
            errorType: 'task',
            retryable: 'no-retry',
            severity: 'warning',
            requestId: 'req-concurrency',
          });
        }
        claimed = true;
        return { taskId: 'task-a', lockTime: '2026-10-10T00:00:00.000Z' };
      },
      renew: async () => ({ lockTime: '2026-10-10T00:00:00.000Z' }),
      finish: async () => undefined,
      finishWithLease: async () => undefined,
      resumeTask: async () => ({ taskId: 'task-a', retryCount: manualRecoveryRetryCount() }),
      getTaskDetail: async () => ({ task: {}, derivedState: 'active' }),
      listTaskErrors: async () => ({ total: 0, list: [], cursor: null }),
      getQueueStats: async () => [],
      updateTrainingData: async () => ({ acceptedCount: 0 }),
      deleteTrainingData: async () => ({ deletedCount: 0 }),
      listCollectionErrors: async () => [],
      hasError: async () => false,
    };
    const service = new ProcessingApplicationService({ repository: repository as never });
    const results = await Promise.allSettled([
      service.claimJob({ taskId: 'task-a', options: { timeoutMs: 5_000 } }, context),
      service.claimJob({ taskId: 'task-a', options: { timeoutMs: 5_000 } }, context),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(buildSyncJobId('team-a', 'dataset-a')).toBe(buildSyncJobId('team-a', 'dataset-a'));
  });

  it('keeps manual recovery at three attempts and never auto-recovers blocked tasks', async () => {
    expect(manualRecoveryRetryCount()).toBe(3);
    expect(canClaim(PROCESSING_PERMANENT_LOCK_TIME, 3, new Date('2049-12-31T23:59:59Z'))).toBe(
      false,
    );
  });
});
