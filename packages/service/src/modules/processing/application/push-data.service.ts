import { ApiErrorException, createApiError } from '@kb/contracts';
import {
  JOB_MODE_TO_QUEUE,
  buildChunkJobId,
  buildParseJobId,
  buildQaJobId,
  buildVectorJobId,
  type QueueName,
  type QueuePort,
} from '@kb/dal';
import type { TaskEnvelope, TaskResult, TrainingProcessorPort } from '../../../ports/capabilities';
import type { ProcessingJobRepository } from '../../../ports/repositories';
import type { PortCallOptions, ProcessingJobSnapshot, RequestContext } from '../../../ports/types';

export interface PushDataServiceDeps {
  jobs: ProcessingJobRepository;
  trainingProcessor: TrainingProcessorPort;
  /** 真实队列投递端；缺失时抛稳定错误，绝不静默返回“已入队”。 */
  queue?: QueuePort;
  maxItems?: number;
  maxBytes?: number;
}

export interface PushBatchItem {
  dataId: string;
  version: number | string;
  payload: unknown;
}

export interface PushBatchInput {
  datasetId: string;
  collectionId: string;
  mode: string;
  items: PushBatchItem[];
  options: PortCallOptions;
}

export interface PushBatchResult {
  accepted: number;
  skipped: number;
  taskIds: string[];
}

/** 按 mode 使用 @kb/dal 稳定 jobId 构造器；重复投递由 jobId 幂等。 */
export function stableJobId(input: {
  mode: string;
  teamId: string;
  datasetId: string;
  collectionId: string;
  dataId: string;
  version: number | string;
}): string {
  switch (input.mode) {
    case 'parse':
      return buildParseJobId(input.teamId, input.datasetId, input.collectionId, input.version);
    case 'chunk':
      return buildChunkJobId(input.teamId, input.datasetId, input.collectionId, input.version);
    case 'vector':
      return buildVectorJobId(input.teamId, input.dataId, input.version);
    case 'qa':
    default:
      return buildQaJobId(input.teamId, input.dataId, input.version);
  }
}

/**
 * 写入路径 C：队列推送（设计文档 9.6 / BR-WRITE-003）。
 * 批量校验（≤200 条且 ≤10MB）→ 先写 Mongo TrainingTask 事实 → 再投递 BullMQ（QueuePort）。
 * 重复 push 按稳定 jobId 去重，不重复创建 Data/Training；不得伪装成直接插入。
 */
export class PushDataService {
  readonly pathKind = 'queue-push' as const;
  readonly usesParser = false;
  readonly usesTrainingQueue = true;

  private readonly maxItems: number;
  private readonly maxBytes: number;

  constructor(private readonly deps: PushDataServiceDeps) {
    // 上限契约由 P4-11 的 shared/http/limits.ts 提供；此处只读取不实现上限常量。
    this.maxItems = deps.maxItems ?? 200;
    this.maxBytes = deps.maxBytes ?? 10 * 1024 * 1024;
  }

  enqueueJob(
    input: {
      job: Omit<ProcessingJobSnapshot, 'taskId' | 'retryCount' | 'lockTime'>;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ taskId: string; jobId: string }> {
    return this.deps.jobs.enqueue(input, context);
  }

  /** 队列投递：缺失 QueuePort 或无对应 queue 映射时抛稳定错误（501062）。 */
  private async deliver(
    mode: string,
    jobId: string,
    payload: unknown,
    context: RequestContext,
  ): Promise<void> {
    const queueName: QueueName | undefined = JOB_MODE_TO_QUEUE[mode];
    if (!this.deps.queue || !queueName) {
      throw new ApiErrorException(
        createApiError({
          code: 501062,
          requestId: context.requestId,
          params: { dependency: 'queue', mode },
        }),
      );
    }
    await this.deps.queue.enqueue(queueName, jobId, payload);
  }

  /**
   * 批量推送：先校验数量与字节上限，再按稳定 jobId 去重后逐条「先事实后队列」。
   */
  async pushBatch(input: PushBatchInput, context: RequestContext): Promise<PushBatchResult> {
    if (input.items.length > this.maxItems) {
      throw new ApiErrorException(
        createApiError({
          code: 501052,
          requestId: context.requestId,
          params: { limit: this.maxItems, actual: input.items.length, batch: 'pushData' },
        }),
      );
    }
    const bytes = Buffer.byteLength(JSON.stringify(input.items), 'utf8');
    if (bytes > this.maxBytes) {
      throw new ApiErrorException(
        createApiError({
          code: 501065,
          requestId: context.requestId,
          params: { limitBytes: this.maxBytes, actualBytes: bytes, urlHash: '' },
        }),
      );
    }

    const seen = new Set<string>();
    const taskIds: string[] = [];
    let skipped = 0;
    for (const item of input.items) {
      const jobId = stableJobId({
        mode: input.mode,
        teamId: context.tenant.teamId,
        datasetId: input.datasetId,
        collectionId: input.collectionId,
        dataId: item.dataId,
        version: item.version,
      });
      if (seen.has(jobId)) {
        skipped += 1;
        continue;
      }
      seen.add(jobId);
      // 1) 先写 Mongo 任务事实
      const fact = await this.deps.jobs.enqueue(
        {
          job: {
            jobId,
            teamId: context.tenant.teamId,
            datasetId: input.datasetId,
            mode: input.mode,
            expireAt: null,
          },
          options: input.options,
        },
        context,
      );
      // 2) 事实成功后再投递队列
      await this.deliver(input.mode, jobId, item.payload, context);
      taskIds.push(fact.taskId);
    }
    return { accepted: taskIds.length, skipped, taskIds };
  }

  processTraining(task: TaskEnvelope, context: RequestContext): Promise<TaskResult> {
    return this.deps.trainingProcessor.process(task, context);
  }
}
