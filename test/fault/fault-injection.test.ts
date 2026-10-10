import { describe, expect, it } from 'vitest';
import { ApiErrorException } from '../../packages/contracts/src/index';
import type { SearchRequest } from '../../packages/contracts/src/index';
import { createSafeLogger, initTracing } from '../../sdk/otel/src/index';
import {
  HealthProbeService,
  classifyRetryableError,
  createDegradedDatasetSearchPort,
} from '../../packages/service/src/index';
import type { RequestContext } from '../../packages/service/src/index';
import { ProcessingApplicationService } from '../../packages/service/src/modules/processing/application';

const context: RequestContext = {
  requestId: 'req-fault',
  tenant: { teamId: 'team-a', tmbId: 'tmb-a', authType: 'internal', isRoot: false },
  permission: { canRead: true, canWrite: false, canManage: false, isOwner: false },
};

describe('FI: dependency and exporter failures never fake success', () => {
  it('turns probe timeouts into failed checks', async () => {
    const health = new HealthProbeService(5);
    health.register({
      name: 'slow-dependency',
      required: true,
      check: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ name: 'slow', status: 'ok', durationMs: 100 }), 50),
        ),
    });
    const checks = await health.checkRequired(context);
    expect(checks[0]?.status).toBe('failed');
  });

  it('records degraded stages instead of returning fabricated search results', async () => {
    const port = createDegradedDatasetSearchPort('integration_test_failure');
    const request: SearchRequest = {
      requestId: 'req-fault',
      teamId: 'team-a',
      datasetIds: ['d1'],
      textQueries: ['hello'],
      imageQueries: [],
      models: { embeddingModel: 'bge-m3' },
      searchMode: 'embedding',
      limit: 10,
      maxTokens: 4000,
      similarity: 0,
    };
    const result = await port.search(request, context);
    expect(result.citations).toEqual([]);
    expect(result.stats.degraded.map((item) => item.stage)).toEqual(['vector', 'fullText']);
    expect(result.stats.degraded[0]?.reason).toBe('integration_test_failure');
  });

  it('keeps otel exporter failures out of the business path', () => {
    const status = initTracing(
      { serviceName: 'kb-test', enabled: true, exporterEndpointRef: 'kb:/otel', logLevel: 'info' },
      () => {
        throw new Error('exporter down');
      },
    );
    expect(status.enabled).toBe(false);
    const logger = createSafeLogger({ name: 'fault-test', level: 'info' });
    expect(() => logger.log('dataset.fault.event', { token: 'secret' })).not.toThrow();
  });

  it('classifies transport failures as retryable without faking success', () => {
    expect(classifyRetryableError({ code: 'ECONNRESET' })).toBe('retryable');
    expect(classifyRetryableError({ code: 400 })).toBe('manual');
  });

  it('lets only the current lease finish after expiry and never fakes stale success', async () => {
    let currentLease = '';
    const completed: string[] = [];
    const repository = {
      enqueue: async () => ({ taskId: 'task-lease', jobId: 'job-lease' }),
      claim: async () => {
        currentLease = `lease-${currentLease === '' ? 'a' : 'b'}`;
        return { taskId: 'task-lease', lockTime: currentLease };
      },
      renew: async (input: { lockTime: string }) => ({ lockTime: input.lockTime }),
      finish: async () => undefined,
      finishWithLease: async (input: { taskId: string; lockTime: string }) => {
        if (input.lockTime !== currentLease) {
          throw new ApiErrorException({
            code: 501005,
            statusText: 'dataset.task.invalid_state',
            messageKey: 'dataset.task.invalid_state',
            params: { taskId: input.taskId },
            message: 'lease lost',
            errorType: 'task',
            retryable: 'no-retry',
            severity: 'warning',
            requestId: 'req-fault',
          });
        }
        completed.push(input.taskId);
      },
      resumeTask: async () => ({ taskId: 'task-lease', retryCount: 3 }),
      getTaskDetail: async () => ({ task: {}, derivedState: 'running' }),
      listTaskErrors: async () => ({ total: 0, list: [], cursor: null }),
      getQueueStats: async () => [],
      updateTrainingData: async () => ({ acceptedCount: 0 }),
      deleteTrainingData: async () => ({ deletedCount: 0 }),
      listCollectionErrors: async () => [],
      hasError: async () => false,
    };
    const service = new ProcessingApplicationService({ repository: repository as never });
    const first: RequestContext = { ...context, requestId: 'worker-a' };
    const second: RequestContext = { ...context, requestId: 'worker-b' };

    await service.claimJob({ taskId: 'task-lease', options: { timeoutMs: 5_000 } }, first);
    await service.claimJob({ taskId: 'task-lease', options: { timeoutMs: 5_000 } }, second);
    await expect(
      service.finishJob(
        { taskId: 'task-lease', state: 'success', options: { timeoutMs: 5_000 } },
        first,
      ),
    ).rejects.toMatchObject({ error: { code: 501005 } });
    await service.finishJob(
      { taskId: 'task-lease', state: 'success', options: { timeoutMs: 5_000 } },
      second,
    );
    expect(completed).toEqual(['task-lease']);
  });
});
