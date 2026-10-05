/**
 * @kb/dal — 队列、缓存与幂等抽象（CR-REF-05，设计文档 12.5 / 12.10）。
 * 显式导出面，禁止 export *。
 */
export const PACKAGE_NAME = '@kb/dal' as const;

export {
  JOB_MODE_TO_QUEUE,
  QUEUE_NAMES,
  buildChunkJobId,
  buildDeleteJobId,
  buildImageJobId,
  buildMigrationJobId,
  buildParseJobId,
  buildQaJobId,
  buildReconcileJobId,
  buildSyncJobId,
  buildVectorJobId,
} from './job-contract';
export type { JobMode, QueueName } from './job-contract';

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

export { BullMqQueueAdapter } from './bullmq-queue';
export type { BullMqQueueConfig } from './bullmq-queue';
export type { EnqueueOptions, EnqueueResult, QueuePort } from './queue-port';
