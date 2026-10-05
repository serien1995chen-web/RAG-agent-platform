import type { QueueName } from './job-contract';

export interface EnqueueOptions {
  /** 优先级；0 为最高，由容量档案注入。 */
  weight?: number;
  delayMs?: number;
  attempts?: number;
}

export interface EnqueueResult {
  jobId: string;
  enqueued: boolean;
}

/**
 * 队列抽象。稳定 jobId 必须由调用方通过 job-contract.ts 构造，
 * 重复投递由 BullMQ jobId 去重；本 Port 不生成 jobId。
 */
export interface QueuePort {
  enqueue(
    queue: QueueName,
    jobId: string,
    payload: unknown,
    options?: EnqueueOptions,
  ): Promise<EnqueueResult>;
  remove(queue: QueueName, jobId: string): Promise<void>;
  close(): Promise<void>;
}
