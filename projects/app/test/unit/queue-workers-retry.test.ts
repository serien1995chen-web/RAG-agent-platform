import { ApiErrorException, createApiError } from '@kb/contracts';
import type { TaskResult } from '@kb/service';
import { DelayedError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { ExtendedAppRuntime } from '../../src/runtime/bootstrap';
import { createChainProcessor, createLifecycleProcessor } from '../../src/runtime/queue-workers';

function fakeJob(
  data: Record<string, unknown>,
  queueName = 'dataset-parse',
): { job: Job; moveToDelayed: ReturnType<typeof vi.fn> } {
  const moveToDelayed = vi.fn(async () => undefined);
  const job = {
    id: 'job-1',
    queueName,
    data,
    moveToDelayed,
  } as unknown as Job;
  return { job, moveToDelayed };
}

function fakeRuntime(): {
  runtime: ExtendedAppRuntime;
  finishJob: ReturnType<typeof vi.fn>;
  logger: { log: ReturnType<typeof vi.fn> };
} {
  const finishJob = vi.fn(async () => undefined);
  const logger = { log: vi.fn(), child: vi.fn() };
  const runtime = {
    config: { system: { timeouts: { requestMs: 1000 } } },
    clients: { logger },
    processingService: {
      claimJob: vi.fn(async () => ({ taskId: 'task-1', lockTime: '2026-01-01T00:00:00.000Z' })),
      renewJob: vi.fn(async () => ({ lockTime: '2026-01-01T00:00:01.000Z' })),
      finishJob,
    },
  } as unknown as ExtendedAppRuntime;
  return { runtime, finishJob, logger };
}

describe('Worker 处理器重试语义（PR #7 Review 问题 2 修复）', () => {
  it('链上 TaskResult.retry：写回 failed 并把 Job 重投（DelayedError）', async () => {
    const { runtime, finishJob, logger } = fakeRuntime();
    const handler = {
      handle: async (): Promise<TaskResult> => ({ state: 'retry', errorMsg: 'temporary' }),
    };
    const processor = createChainProcessor(runtime, handler);
    const { job, moveToDelayed } = fakeJob({
      mode: 'parse',
      teamId: 'team-1',
      datasetId: 'ds-1',
      payload: { taskId: 'task-1' },
    });

    await expect(processor(job, 'token-1')).rejects.toBeInstanceOf(DelayedError);
    expect(finishJob).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', state: 'failed', errorMsg: 'temporary' }),
      expect.anything(),
    );
    expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token-1');
    expect(logger.log).toHaveBeenCalledWith('queue-workers.job_retry', { jobId: 'job-1' });
  });

  it('链上 TaskResult.success：正常提交完成，不重投', async () => {
    const { runtime, finishJob } = fakeRuntime();
    const processor = createChainProcessor(runtime, {
      handle: async (): Promise<TaskResult> => ({ state: 'success' }),
    });
    const { job, moveToDelayed } = fakeJob({
      mode: 'parse',
      teamId: 'team-1',
      payload: { taskId: 'task-1' },
    });

    await expect(processor(job, 'token-1')).resolves.toBeUndefined();
    expect(finishJob).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', state: 'success' }),
      expect.anything(),
    );
    expect(moveToDelayed).not.toHaveBeenCalled();
  });

  it('链上可重试异常：仍按分类写回 failed 并向上抛出交 BullMQ', async () => {
    const { runtime, finishJob } = fakeRuntime();
    const error = new ApiErrorException(
      createApiError({ code: 501016, requestId: 'req-1', params: { store: 'mongo' } }),
    );
    const processor = createChainProcessor(runtime, {
      handle: async () => {
        throw error;
      },
    });
    const { job } = fakeJob({
      mode: 'parse',
      teamId: 'team-1',
      payload: { taskId: 'task-1' },
    });

    await expect(processor(job, 'token-1')).rejects.toBe(error);
    expect(finishJob).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', state: 'failed' }),
      expect.anything(),
    );
  });

  it('生命周期 TaskResult.retry：重投；failed：只记录不重投', async () => {
    const retryRuntime = fakeRuntime();
    const retryProcessor = createLifecycleProcessor(retryRuntime.runtime, {
      handle: async (): Promise<TaskResult> => ({ state: 'retry' }),
    });
    const retryJob = fakeJob({ mode: 'sync', teamId: 'team-1', payload: {} }, 'dataset-sync');
    await expect(retryProcessor(retryJob.job, 'token-9')).rejects.toBeInstanceOf(DelayedError);
    expect(retryJob.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token-9');

    const failedRuntime = fakeRuntime();
    const failedProcessor = createLifecycleProcessor(failedRuntime.runtime, {
      handle: async (): Promise<TaskResult> => ({ state: 'failed', errorMsg: 'terminal' }),
    });
    const failedJob = fakeJob({ mode: 'sync', teamId: 'team-1', payload: {} }, 'dataset-sync');
    await expect(failedProcessor(failedJob.job, 'token-9')).resolves.toBeUndefined();
    expect(failedJob.moveToDelayed).not.toHaveBeenCalled();
    expect(failedRuntime.logger.log).toHaveBeenCalledWith(
      'queue-workers.lifecycle_non_success',
      expect.objectContaining({ state: 'failed' }),
    );
  });
});
