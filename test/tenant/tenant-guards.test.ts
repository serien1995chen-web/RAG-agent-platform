import { describe, expect, it } from 'vitest';
import { ApiErrorException } from '../../packages/contracts/src/index';
import { evaluatePermission } from '../../packages/acl/src/index';
import { validateTenantContext } from '../../packages/service/src/index';
import { ProcessingApplicationService } from '../../packages/service/src/modules/processing/application';
import type { RequestContext } from '../../packages/service/src/ports/types';
import { assertObjectKeyScope } from '../../sdk/storage/src/index';

describe('TEN: cross-tenant guards', () => {
  it('rejects missing tenant context with stable 501012', () => {
    const result = validateTenantContext(null, 'req-ten');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(501012);
      expect(result.error.severity).toBe('fatal');
    }
  });

  it('rejects a partial tenant context before any storage access', () => {
    const result = validateTenantContext(
      { teamId: 'team-a', tmbId: '', authType: 'token', isRoot: false },
      'req-partial-tenant',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(501012);
  });

  it('rejects cross-team object keys before touching storage (501061)', () => {
    expect(() =>
      assertObjectKeyScope({ bucket: 'b', key: 'temp/team-b/file' }, { teamId: 'team-a' }),
    ).toThrowError(/501061/);
  });

  it('keeps explicit deny at zero permission even when parent inherits full mask', () => {
    expect(
      evaluatePermission({
        inheritedMask: 15,
        explicitMask: 0,
        isOwner: false,
        isRoot: false,
      }),
    ).toBe(0);
  });

  it('rejects cross-team task views through every training application path', async () => {
    const crossTeamContext: RequestContext = {
      requestId: 'req-cross-team',
      tenant: { teamId: 'team-b', tmbId: 'tmb-b', authType: 'token', isRoot: false },
      permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
    };
    const notFound = (): never => {
      throw new ApiErrorException({
        code: 501070,
        statusText: 'dataset.resource_not_found',
        messageKey: 'dataset.resource_not_found',
        params: { resourceType: 'task', resourceId: 'task-a' },
        message: 'not found',
        errorType: 'validation',
        retryable: 'no-retry',
        severity: 'warning',
        requestId: crossTeamContext.requestId,
      });
    };
    const repository = {
      enqueue: async () => ({ taskId: 'task-a', jobId: 'job-a' }),
      claim: async () => notFound(),
      renew: async () => notFound(),
      finish: async () => notFound(),
      finishWithLease: async () => notFound(),
      resumeTask: async () => notFound(),
      getTaskDetail: async () => notFound(),
      listTaskErrors: async () => notFound(),
      getQueueStats: async () => notFound(),
      updateTrainingData: async () => notFound(),
      deleteTrainingData: async () => notFound(),
      listCollectionErrors: async () => notFound(),
      hasError: async () => notFound(),
    };
    const service = new ProcessingApplicationService({ repository: repository as never });
    const calls = [
      service.getTaskDetail({ taskId: 'task-a', options: { timeoutMs: 5_000 } }, crossTeamContext),
      service.listTaskErrors(
        { datasetId: 'dataset-a', limit: 20, options: { timeoutMs: 5_000 } },
        crossTeamContext,
      ),
      service.resumeTask(
        { taskId: 'task-a', reason: 'manual', options: { timeoutMs: 5_000 } },
        crossTeamContext,
      ),
      service.getQueueStats(
        { datasetId: 'dataset-a', options: { timeoutMs: 5_000 } },
        crossTeamContext,
      ),
      service.updateTrainingData(
        { datasetId: 'dataset-a', mode: 'qa', options: { timeoutMs: 5_000 } },
        crossTeamContext,
      ),
      service.deleteTrainingData(
        { collectionId: 'collection-a', options: { timeoutMs: 5_000 } },
        crossTeamContext,
      ),
      service.listCollectionErrors(
        { collectionId: 'collection-a', options: { timeoutMs: 5_000 } },
        crossTeamContext,
      ),
      service.hasError({ datasetId: 'dataset-a', options: { timeoutMs: 5_000 } }, crossTeamContext),
    ];
    for (const call of calls) {
      await expect(call).rejects.toMatchObject({ error: { code: 501070 } });
    }
  });
});
