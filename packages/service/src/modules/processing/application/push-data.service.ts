import type { TaskEnvelope, TaskResult, TrainingProcessorPort } from '../../../ports/capabilities';
import type { ProcessingJobRepository } from '../../../ports/repositories';
import type { PortCallOptions, ProcessingJobSnapshot, RequestContext } from '../../../ports/types';

export interface PushDataServiceDeps {
  jobs: ProcessingJobRepository;
  trainingProcessor: TrainingProcessorPort;
}

/**
 * 写入路径 C：队列推送（设计文档 1.5 / 8.2）。
 * pushData 或 insertImages -> TrainingTask -> QA、向量或图片处理 -> Data、Index 与投影。
 * 该路径不经过 Parser；任务必须先写 Mongo 事实再投递 BullMQ。
 */
export class PushDataService {
  readonly pathKind = 'queue-push' as const;
  readonly usesParser = false;
  readonly usesTrainingQueue = true;

  constructor(private readonly deps: PushDataServiceDeps) {}

  enqueueJob(
    input: {
      job: Omit<ProcessingJobSnapshot, 'taskId' | 'retryCount' | 'lockTime'>;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ taskId: string; jobId: string }> {
    return this.deps.jobs.enqueue(input, context);
  }

  processTraining(task: TaskEnvelope, context: RequestContext): Promise<TaskResult> {
    return this.deps.trainingProcessor.process(task, context);
  }
}
