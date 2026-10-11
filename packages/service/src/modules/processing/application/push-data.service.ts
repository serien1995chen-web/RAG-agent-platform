import { ApiErrorException, createApiError } from "@kb/contracts";
import type { TaskEnvelope, TaskResult, TrainingProcessorPort } from "../../../ports/capabilities";
import type { ProcessingJobRepository } from "../../../ports/repositories";
import type { PortCallOptions, ProcessingJobSnapshot, RequestContext } from "../../../ports/types";

export interface PushDataServiceDeps {
  jobs: ProcessingJobRepository;
  trainingProcessor: TrainingProcessorPort;
  maxItems?: number;
  maxBytes?: number;
}

export interface PushBatchInput {
  datasetId: string;
  collectionId: string;
  mode: string;
  items: Array<{ jobId: string; payload: unknown }>;
  options: PortCallOptions;
}

export interface PushBatchResult {
  accepted: number;
  skipped: number;
  taskIds: string[];
}

/**
 * 写入路径 C：队列推送（设计文档 9.6 / BR-WRITE-003）。
 * 批量校验（≤200 条且 ≤10MB）→ 先写 Mongo TrainingTask 事实 → 再投递 BullMQ。
 * 重复 push 按业务键（jobId）去重，不重复创建 Data/Training；不得伪装成直接插入。
 */
export class PushDataService {
  readonly pathKind = "queue-push" as const;
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
      job: Omit<ProcessingJobSnapshot, "taskId" | "retryCount" | "lockTime">;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ taskId: string; jobId: string }> {
    return this.deps.jobs.enqueue(input, context);
  }

  /**
   * 批量推送：先校验数量与字节上限，再按 jobId 去重后逐条「先事实后队列」。
   */
  async pushBatch(input: PushBatchInput, context: RequestContext): Promise<PushBatchResult> {
    if (input.items.length > this.maxItems) {
      throw new ApiErrorException(
        createApiError({
          code: 501052,
          requestId: context.requestId,
          params: { limit: this.maxItems, actual: input.items.length, batch: "pushData" },
        }),
      );
    }
    const bytes = Buffer.byteLength(JSON.stringify(input.items), "utf8");
    if (bytes > this.maxBytes) {
      throw new ApiErrorException(
        createApiError({
          code: 501065,
          requestId: context.requestId,
          params: { limitBytes: this.maxBytes, actualBytes: bytes, urlHash: "" },
        }),
      );
    }

    const seen = new Set<string>();
    const taskIds: string[] = [];
    let skipped = 0;
    for (const item of input.items) {
      if (seen.has(item.jobId)) {
        skipped += 1;
        continue;
      }
      seen.add(item.jobId);
      const job: Omit<ProcessingJobSnapshot, "taskId" | "retryCount" | "lockTime"> = {
        jobId: item.jobId,
        teamId: context.tenant.teamId,
        datasetId: input.datasetId,
        mode: input.mode,
        expireAt: null,
      };
      // 先写 Mongo 任务事实；Repository 实现负责随后的 BullMQ 投递。
      const result = await this.deps.jobs.enqueue({ job, options: input.options }, context);
      taskIds.push(result.taskId);
    }
    return { accepted: taskIds.length, skipped, taskIds };
  }

  processTraining(task: TaskEnvelope, context: RequestContext): Promise<TaskResult> {
    return this.deps.trainingProcessor.process(task, context);
  }
}
