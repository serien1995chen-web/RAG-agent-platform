import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import type { QueueName } from './job-contract';
import type { EnqueueOptions, EnqueueResult, QueuePort } from './queue-port';

export interface BullMqQueueConfig {
  connection: ConnectionOptions;
  prefix?: string;
}

/** BullMQ 队列适配器：稳定 jobId 去重；成功任务删除，失败保留以支持人工恢复。 */
export class BullMqQueueAdapter implements QueuePort {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly config: BullMqQueueConfig) {}

  private queue(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;
    const created = new Queue(name, {
      connection: this.config.connection,
      ...(this.config.prefix !== undefined ? { prefix: this.config.prefix } : {}),
    });
    this.queues.set(name, created);
    return created;
  }

  async enqueue(
    queue: QueueName,
    jobId: string,
    payload: unknown,
    options: EnqueueOptions = {},
  ): Promise<EnqueueResult> {
    const jobOptions: JobsOptions = {
      jobId,
      removeOnComplete: true,
      removeOnFail: false,
      ...(options.weight !== undefined ? { priority: options.weight } : {}),
      ...(options.delayMs !== undefined ? { delay: options.delayMs } : {}),
      ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
    };
    const existing = await this.queue(queue).getJob(jobId);
    if (existing) return { jobId, enqueued: false };
    await this.queue(queue).add(jobId, payload, jobOptions);
    return { jobId, enqueued: true };
  }

  async remove(queue: QueueName, jobId: string): Promise<void> {
    const job = await this.queue(queue).getJob(jobId);
    if (job) await job.remove();
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}
