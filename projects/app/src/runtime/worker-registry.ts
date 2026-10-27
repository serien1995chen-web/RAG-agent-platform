import { createKnowledgeError } from '@kb/contracts';
import { KNOWLEDGE_QUEUE_NAMES, type KnowledgeQueueName } from '@kb/dal';
import { Worker, type ConnectionOptions } from 'bullmq';
import type { SafeLogFields } from '@kb/otel';
import type { S06QueuePayload, KnowledgeQueueOutcome } from './s06-job-handlers';

export interface QueueConsumerDefinition {
  queue: KnowledgeQueueName;
  concurrency: number;
  timeoutMs: number;
  maxAttempts: number;
  backoffMs: readonly number[];
  handler: (payload: S06QueuePayload, workerId: string) => Promise<KnowledgeQueueOutcome>;
}

export interface KnowledgeWorkerLogger {
  log(event: string, details?: SafeLogFields): void;
}

export function createWorkerRegistry(
  definitions: readonly QueueConsumerDefinition[],
): ReadonlyMap<KnowledgeQueueName, QueueConsumerDefinition> {
  const registry = new Map<KnowledgeQueueName, QueueConsumerDefinition>();
  for (const definition of definitions) {
    if (!(KNOWLEDGE_QUEUE_NAMES as readonly string[]).includes(definition.queue)) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: 'worker-registry',
        traceId: 'worker-registry',
        details: { queue: definition.queue, reason: 'unknown_queue' },
      });
    }
    if (registry.has(definition.queue)) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: 'worker-registry',
        traceId: 'worker-registry',
        details: { queue: definition.queue, reason: 'repeated_registration' },
      });
    }
    if (typeof definition.handler !== 'function') {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: 'worker-registry',
        traceId: 'worker-registry',
        details: { queue: definition.queue, reason: 'handler_required' },
      });
    }
    registry.set(definition.queue, Object.freeze(definition));
  }
  const missing = KNOWLEDGE_QUEUE_NAMES.filter((queue) => !registry.has(queue));
  if (missing.length > 0) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: 'worker-registry',
      traceId: 'worker-registry',
      details: { missing },
    });
  }
  return registry;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, queue: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        createKnowledgeError({
          code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
          requestId: `worker:${queue}`,
          traceId: `worker:${queue}`,
          details: { queue, timeoutMs },
        }),
      );
    }, timeoutMs);
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function startWorkerRegistry(input: {
  registry: ReadonlyMap<KnowledgeQueueName, QueueConsumerDefinition>;
  connection: ConnectionOptions;
  workerId: string;
  logger: KnowledgeWorkerLogger;
}): { workers: Worker[]; ready: Promise<void>; close: () => Promise<void> } {
  const workers = [...input.registry.values()].map((definition) => {
    const worker = new Worker<S06QueuePayload>(
      definition.queue,
      async (job) => {
        const outcome = await withTimeout(
          definition.handler(job.data, input.workerId),
          definition.timeoutMs,
          definition.queue,
        );
        if (outcome === 'retry') {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_JOB_FAILED',
            requestId: `worker:${definition.queue}`,
            traceId: `worker:${definition.queue}`,
            details: { reason: 'handler_requested_retry', queue: definition.queue },
          });
        }
        return { outcome };
      },
      {
        connection: input.connection,
        concurrency: definition.concurrency,
        lockDuration: definition.timeoutMs,
        maxStalledCount: 1,
      },
    );
    worker.on('failed', (_job, _error) => {
      input.logger.log('knowledge.worker.job.failed', {
        operation: `worker.job.failed:${definition.queue}`,
      });
    });
    return worker;
  });
  const ready = Promise.all(workers.map((worker) => worker.waitUntilReady())).then(() => {
    input.logger.log('knowledge.worker.ready', {
      operation: `worker.ready:${workers.length}`,
    });
  });
  return {
    workers,
    ready,
    async close() {
      await Promise.all(workers.map((worker) => worker.close()));
    },
  };
}
