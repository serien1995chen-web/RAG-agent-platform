import { ApiErrorException, createApiError } from '@kb/contracts';
import { JOB_MODE_TO_QUEUE } from '@kb/dal';
import {
  ConfigValidationException,
  DELETE_JOB_JOB_DEFINITIONS,
  KNOWLEDGE_BASE_JOB_DEFINITIONS,
  MIGRATION_RUN_JOB_DEFINITIONS,
  PROCESSING_JOB_JOB_DEFINITIONS,
  classifyRetryableError,
  createDeleteJobJobHandler,
  createKnowledgeBaseJobHandler,
  createKnowledgeItemJobHandler,
  createMigrationRunJobHandler,
  createProcessingJobJobHandler,
  createSourceCollectionJobHandler,
  type JobDefinition,
  type JobEnvelope,
  type RequestContext,
  type TaskResult,
} from '@kb/service';
import { Worker, type Job } from 'bullmq';
// Plan D4 冻结 @kb/service barrel（不在 25 条文件清单内）；心跳常量按相对路径引用包内实现。
import { PROCESSING_HEARTBEAT_MS } from '../../../../packages/service/src/modules/processing/domain/lease';
import type { ExtendedAppRuntime } from './bootstrap';
import type { RuntimeUnit } from './drain';

/** 链上队列（parse/chunk/qa/vector）与生命周期队列共用同一 Worker 装配入口。 */
type RuntimeJobHandler = {
  handle(envelope: JobEnvelope, context: RequestContext): Promise<TaskResult>;
};

interface LifecycleBinding {
  definition: JobDefinition;
  handler: RuntimeJobHandler;
}

type FinishState = 'success' | 'failed' | 'blocked' | 'final_error';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function modeOfQueue(queueName: string): string {
  for (const [mode, queue] of Object.entries(JOB_MODE_TO_QUEUE)) {
    if (queue === queueName) return mode;
  }
  return '';
}

/** 解析 BullMQ Job 为 JobEnvelope；queue/mode 组合由各 handler 注册表最终校验。 */
function parseEnvelope(job: Job): { envelope: JobEnvelope; taskId: string | undefined } {
  const data = isRecord(job.data) ? job.data : {};
  const payload = isRecord(data['payload']) ? data['payload'] : {};
  const queue = String(job.queueName);
  const declaredMode = data['mode'];
  const mode =
    typeof declaredMode === 'string' && declaredMode.length > 0 ? declaredMode : modeOfQueue(queue);
  const envelope: JobEnvelope = {
    jobId: job.id === undefined ? '' : String(job.id),
    queue,
    mode,
    teamId: typeof data['teamId'] === 'string' ? data['teamId'] : '',
    ...(typeof data['datasetId'] === 'string' ? { datasetId: data['datasetId'] } : {}),
    ...(typeof data['collectionId'] === 'string' ? { collectionId: data['collectionId'] } : {}),
    ...(typeof data['dataId'] === 'string' ? { dataId: data['dataId'] } : {}),
    payload,
    retryCount: typeof data['retryCount'] === 'number' ? data['retryCount'] : 0,
    lockTime: typeof data['lockTime'] === 'string' ? data['lockTime'] : null,
  };
  const taskId =
    typeof payload['taskId'] === 'string' && payload['taskId'].length > 0
      ? payload['taskId']
      : undefined;
  return { envelope, taskId };
}

function invalidEnvelope(envelope: JobEnvelope): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501005,
      requestId: envelope.jobId,
      params: { taskId: envelope.jobId, from: envelope.mode, to: 'invalid_envelope' },
    }),
  );
}

function workerContext(envelope: JobEnvelope, timeoutMs: number): RequestContext {
  return {
    requestId: envelope.jobId,
    timeoutMs,
    tenant: { teamId: envelope.teamId, tmbId: 'system', authType: 'internal', isRoot: false },
    permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
  };
}

/** reconcile 由 Cron/手动触发（设计 16.4），无 teamId 时按 Root 主体执行。 */
function lifecycleContext(envelope: JobEnvelope, timeoutMs: number): RequestContext {
  if (envelope.mode === 'reconcile' || envelope.teamId.length > 0) {
    return {
      requestId: envelope.jobId,
      timeoutMs,
      tenant: {
        teamId: envelope.teamId.length > 0 ? envelope.teamId : 'root',
        tmbId: envelope.teamId.length > 0 ? 'system' : 'root',
        authType: envelope.teamId.length > 0 ? 'internal' : 'root',
        isRoot: envelope.teamId.length === 0,
      },
      permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
    };
  }
  throw invalidEnvelope(envelope);
}

function errorLabel(error: unknown): string {
  if (error instanceof ApiErrorException) return error.error.messageKey;
  return error instanceof Error ? error.name : typeof error;
}

function mapTaskResultState(result: TaskResult): FinishState {
  if (result.state === 'success') return 'success';
  if (result.state === 'retry') return 'failed';
  return 'final_error';
}

function failureState(error: unknown): { state: FinishState; retryable: string } {
  const retryable = classifyRetryableError(error);
  if (retryable === 'retryable') return { state: 'failed', retryable };
  if (retryable === 'no-retry') return { state: 'final_error', retryable };
  return { state: 'blocked', retryable };
}

/** 链上处理器（设计 12.10）：claim → handler → 心跳续租 → finish。 */
function createChainProcessor(
  runtime: ExtendedAppRuntime,
  handler: RuntimeJobHandler,
): (job: Job) => Promise<void> {
  const timeoutMs = runtime.config.system.timeouts.requestMs;
  const options = { timeoutMs };
  return async (job) => {
    const { envelope, taskId } = parseEnvelope(job);
    if (envelope.teamId.length === 0 || envelope.mode.length === 0 || taskId === undefined) {
      throw invalidEnvelope(envelope);
    }
    const context = workerContext(envelope, timeoutMs);
    const claimed = await runtime.processingService.claimJob({ taskId, options }, context);
    let lockTime = claimed.lockTime;
    const heartbeat = setInterval(() => {
      void runtime.processingService
        .renewJob({ taskId, lockTime, options }, context)
        .then((renewed) => {
          lockTime = renewed.lockTime;
        })
        .catch((error: unknown) => {
          runtime.clients.logger.log('queue-workers.renew_failed', {
            jobId: envelope.jobId,
            error: errorLabel(error),
          });
        });
    }, PROCESSING_HEARTBEAT_MS);

    let result: TaskResult;
    try {
      result = await handler.handle(envelope, context);
    } catch (error) {
      const { state, retryable } = failureState(error);
      try {
        await runtime.processingService.finishJob(
          { taskId, state, errorMsg: errorLabel(error), options },
          context,
        );
      } catch (finishError) {
        runtime.clients.logger.log('queue-workers.finish_failed', {
          jobId: envelope.jobId,
          error: errorLabel(finishError),
        });
      }
      runtime.clients.logger.log('queue-workers.job_failed', {
        jobId: envelope.jobId,
        state,
        retryable,
      });
      // retryable 交给 BullMQ 重试策略；no-retry/manual 的终态已写入任务事实源。
      if (retryable === 'retryable') throw error;
      return;
    } finally {
      clearInterval(heartbeat);
    }

    try {
      await runtime.processingService.finishJob(
        {
          taskId,
          state: mapTaskResultState(result),
          ...(result.errorMsg !== undefined ? { errorMsg: result.errorMsg } : {}),
          options,
        },
        context,
      );
    } catch (error) {
      runtime.clients.logger.log('queue-workers.finish_failed', {
        jobId: envelope.jobId,
        error: errorLabel(error),
      });
      throw error;
    }
  };
}

/**
 * 生命周期处理器：delete/sync/reconcile/migration 只做 payload→Port 调用，
 * 任务状态回写留在各自 Port/Repository；失败分类决定是否交回 BullMQ 重试。
 */
function createLifecycleProcessor(
  runtime: ExtendedAppRuntime,
  handler: RuntimeJobHandler,
): (job: Job) => Promise<void> {
  const timeoutMs = runtime.config.system.timeouts.requestMs;
  return async (job) => {
    const { envelope } = parseEnvelope(job);
    if (envelope.mode.length === 0) throw invalidEnvelope(envelope);
    const context = lifecycleContext(envelope, timeoutMs);
    try {
      const result = await handler.handle(envelope, context);
      if (result.state !== 'success') {
        runtime.clients.logger.log('queue-workers.lifecycle_non_success', {
          jobId: envelope.jobId,
          mode: envelope.mode,
          state: result.state,
        });
      }
    } catch (error) {
      const { state, retryable } = failureState(error);
      runtime.clients.logger.log('queue-workers.lifecycle_failed', {
        jobId: envelope.jobId,
        mode: envelope.mode,
        state,
        retryable,
      });
      if (retryable === 'retryable') throw error;
    }
  };
}

function firstDefinition(definitions: readonly JobDefinition[], name: string): JobDefinition {
  const definition = definitions[0];
  if (!definition) throw new ConfigValidationException([`缺少 ${name} Job 定义`]);
  return definition;
}

function createWorkerUnit(
  runtime: ExtendedAppRuntime,
  queueName: string,
  processor: (job: Job) => Promise<void>,
  concurrency: number,
): RuntimeUnit {
  const worker = new Worker(queueName, processor, {
    connection: runtime.clients.redis,
    concurrency,
  });
  worker.on('error', (error) => {
    runtime.clients.logger.log('queue-workers.worker_error', {
      queue: queueName,
      error: error instanceof Error ? error.name : typeof error,
    });
  });
  return {
    name: `queue-worker:${queueName}`,
    phase: 'claims',
    async close() {
      // 停止领取并等待在途任务（设计 6.5.1）。
      await worker.close();
    },
  };
}

/**
 * Worker 装配唯一入口（P3-03）：链上 4 个队列 + 生命周期 4 个队列各建 1 个 BullMQ Worker；
 * 注册键 = `${queue}:${mode}`，重复即启动失败；连接复用 runtime.clients.redis。
 */
export function createRuntimeWorkerUnits(runtime: ExtendedAppRuntime): RuntimeUnit[] {
  const collectionHandler: RuntimeJobHandler = createSourceCollectionJobHandler({
    trainingProcessor: runtime.ports.trainingProcessor,
  });
  const itemHandler: RuntimeJobHandler = createKnowledgeItemJobHandler({
    trainingProcessor: runtime.ports.trainingProcessor,
  });
  const chainHandler: RuntimeJobHandler = createProcessingJobJobHandler({
    handlersByMode: {
      parse: collectionHandler,
      chunk: collectionHandler,
      qa: itemHandler,
      vector: itemHandler,
    },
  });
  const deleteHandler: RuntimeJobHandler = createDeleteJobJobHandler({
    deleteRepository: runtime.ports.deleteJobRepository,
  });
  const syncHandler: RuntimeJobHandler = createKnowledgeBaseJobHandler({
    datasetSync: runtime.ports.datasetSync,
  });
  const migrationHandler: RuntimeJobHandler = createMigrationRunJobHandler({
    migrationRegistry: runtime.ports.migrationRegistry,
    adminDataset: runtime.ports.adminDataset,
  });

  const lifecycleBindings: LifecycleBinding[] = [
    { definition: firstDefinition(DELETE_JOB_JOB_DEFINITIONS, 'delete'), handler: deleteHandler },
    { definition: firstDefinition(KNOWLEDGE_BASE_JOB_DEFINITIONS, 'sync'), handler: syncHandler },
    ...MIGRATION_RUN_JOB_DEFINITIONS.map((definition) => ({
      definition,
      handler: migrationHandler,
    })),
  ];

  const seen = new Set<string>();
  for (const definition of [
    ...PROCESSING_JOB_JOB_DEFINITIONS,
    ...lifecycleBindings.map((binding) => binding.definition),
  ]) {
    for (const mode of definition.modes) {
      const key = `${definition.queue}:${mode}`;
      if (seen.has(key)) throw new ConfigValidationException([`重复的 Worker 注册：${key}`]);
      seen.add(key);
    }
  }

  const concurrency = runtime.config.capacity.queueConcurrency;
  const units: RuntimeUnit[] = [];
  const chainProcessor = createChainProcessor(runtime, chainHandler);
  for (const definition of PROCESSING_JOB_JOB_DEFINITIONS) {
    units.push(createWorkerUnit(runtime, definition.queue, chainProcessor, concurrency));
  }
  for (const binding of lifecycleBindings) {
    const processor = createLifecycleProcessor(runtime, binding.handler);
    units.push(createWorkerUnit(runtime, binding.definition.queue, processor, concurrency));
  }
  return units;
}
