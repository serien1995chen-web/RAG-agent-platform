export const PACKAGE_NAME = '@kb/dal' as const;

export {
  JOB_MODE_TO_QUEUE,
  KNOWLEDGE_QUEUE_NAMES,
  QUEUE_NAMES,
  buildKnowledgeJobId,
} from './job-contract';
export type { JobMode, KnowledgeJobIdInput, KnowledgeQueueName, QueueName } from './job-contract';

export {
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  MemoryIdempotencyStore,
  RedisIdempotencyStore,
  buildIdempotencyScopeKey,
} from './idempotency';
export type {
  BeginIdempotencyResult,
  IdempotencyRecord,
  IdempotencyState,
  IdempotencyStore,
} from './idempotency';

export { BullMqQueueAdapter, KNOWLEDGE_JOB_RETENTION } from './bullmq-queue';
export type { BullMqQueueConfig } from './bullmq-queue';
export type { EnqueueOptions, EnqueueResult, QueuePort } from './queue-port';
