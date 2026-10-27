import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { createKnowledgeError } from '@kb/contracts';
import type { KnowledgeQueueName } from './job-contract';
import type { EnqueueOptions, EnqueueResult, QueuePort } from './queue-port';

export interface BullMqQueueConfig {
  connection: ConnectionOptions;
  prefix?: string;
}

const COMPLETE_RETENTION = Object.freeze({
  count: 1000,
  age: 7 * 24 * 60 * 60,
});

export class BullMqQueueAdapter implements QueuePort {
  private readonly queues = new Map<KnowledgeQueueName, Queue>();

  constructor(private readonly config: BullMqQueueConfig) {}

  private queue(name: KnowledgeQueueName): Queue {
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
    queue: KnowledgeQueueName,
    jobId: string,
    payload: unknown,
    options: EnqueueOptions = {},
  ): Promise<EnqueueResult> {
    if (!jobId.startsWith('k_') || jobId.length !== 42) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: 'queue-enqueue',
        traceId: 'queue-enqueue',
        details: { field: 'jobId', reason: 'stable_knowledge_job_id_required' },
      });
    }
    const jobOptions: JobsOptions = {
      jobId,
      removeOnComplete: COMPLETE_RETENTION,
      removeOnFail: false,
      ...(options.weight !== undefined ? { priority: options.weight } : {}),
      ...(options.delayMs !== undefined ? { delay: options.delayMs } : {}),
      ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
      ...(options.backoff !== undefined ? { backoff: options.backoff } : {}),
    };
    const existing = await this.queue(queue).getJob(jobId);
    if (existing) return { jobId, enqueued: false };
    await this.queue(queue).add(jobId, payload, jobOptions);
    return { jobId, enqueued: true };
  }

  async remove(queue: KnowledgeQueueName, jobId: string): Promise<void> {
    const job = await this.queue(queue).getJob(jobId);
    if (job) await job.remove();
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }
}

export const KNOWLEDGE_JOB_RETENTION = {
  complete: COMPLETE_RETENTION,
  fail: false,
} as const;
