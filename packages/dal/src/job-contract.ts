/**
 * 异步 Job 契约（设计文档 12.10）：稳定 jobId、队列名与幂等语义。
 * 规则：必须先写 Mongo 事实再投递 BullMQ；成功任务删除，不写虚假 completed。
 */
export const QUEUE_NAMES = {
  parse: 'dataset-parse',
  chunk: 'dataset-chunk',
  qa: 'dataset-qa',
  vector: 'dataset-vector',
  image: 'dataset-image',
  imageParse: 'dataset-image-parse',
  delete: 'dataset-delete',
  sync: 'dataset-sync',
  reconcile: 'dataset-reconcile',
  migration: 'dataset-migration',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export type JobMode = 'parse' | 'chunk' | 'qa' | 'image' | 'imageParse' | 'delete' | 'sync';

export function buildParseJobId(
  teamId: string,
  datasetId: string,
  collectionId: string,
  version: number | string,
): string {
  return `${teamId}:${datasetId}:${collectionId}:parse:${version}`;
}

export function buildChunkJobId(
  teamId: string,
  datasetId: string,
  collectionId: string,
  version: number | string,
): string {
  return `${teamId}:${datasetId}:${collectionId}:chunk:${version}`;
}

export function buildQaJobId(teamId: string, dataId: string, version: number | string): string {
  return `${teamId}:${dataId}:qa:${version}`;
}

export function buildVectorJobId(teamId: string, dataId: string, version: number | string): string {
  return `${teamId}:${dataId}:vector:${version}`;
}

export function buildImageJobId(
  teamId: string,
  datasetId: string,
  imageId: string,
  mode: 'image' | 'imageParse',
): string {
  return `${teamId}:${datasetId}:${imageId}:${mode}`;
}

export function buildDeleteJobId(teamId: string, datasetId: string): string {
  return `${teamId}:${datasetId}:delete`;
}

export function buildSyncJobId(teamId: string, datasetId: string): string {
  return `${teamId}:${datasetId}:sync`;
}

export function buildReconcileJobId(windowStart: string, windowEnd: string, scope: string): string {
  return `reconcile:${windowStart}:${windowEnd}:${scope}`;
}

export function buildMigrationJobId(teamId: string, migrationId: string, batchId: string): string {
  return `${teamId}:${migrationId}:${batchId}`;
}

export const JOB_MODE_TO_QUEUE: Readonly<Record<string, QueueName>> = {
  parse: QUEUE_NAMES.parse,
  chunk: QUEUE_NAMES.chunk,
  qa: QUEUE_NAMES.qa,
  vector: QUEUE_NAMES.vector,
  image: QUEUE_NAMES.image,
  imageParse: QUEUE_NAMES.imageParse,
  delete: QUEUE_NAMES.delete,
  sync: QUEUE_NAMES.sync,
  reconcile: QUEUE_NAMES.reconcile,
  migration: QUEUE_NAMES.migration,
};
