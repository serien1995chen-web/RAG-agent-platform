import { QUEUE_NAMES } from '@kb/dal';
import type { TaskEnvelope, TaskResult, TrainingProcessorPort } from '../../../ports/capabilities';
import type { JobDefinition, JobEnvelope, RequestContext } from '../../../ports/types';

/**
 * P3-03：与 `PROCESSING_JOB_JOB_DEFINITIONS` 的 parse/chunk 数值一致；
 * 原骨架 `auto` 不是队列模式（由 ChunkPolicy 处理），已去除。
 */
export const SOURCE_COLLECTION_JOB_DEFINITIONS: readonly JobDefinition[] = [
  {
    name: 'collection-parse',
    queue: QUEUE_NAMES.parse,
    modes: ['parse'],
    stableIdTemplate: 'teamId:datasetId:collectionId:parse:version',
  },
  {
    name: 'collection-chunk',
    queue: QUEUE_NAMES.chunk,
    modes: ['chunk'],
    stableIdTemplate: 'teamId:datasetId:collectionId:chunk:version',
  },
];

export interface SourceCollectionJobHandler {
  handle(envelope: JobEnvelope, context: RequestContext): Promise<TaskResult>;
}

export interface SourceCollectionJobHandlerDeps {
  trainingProcessor: TrainingProcessorPort;
}

/** payload 白名单（P3-03）：未识别字段一律丢弃，禁止透传正文/密钥。 */
const COLLECTION_PAYLOAD_FIELDS = [
  'taskId',
  'version',
  'sourceRef',
  'policy',
  'datasetId',
  'collectionId',
  'dataId',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function whitelistPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  const mapped: Record<string, unknown> = {};
  for (const field of COLLECTION_PAYLOAD_FIELDS) {
    if (payload[field] !== undefined) mapped[field] = payload[field];
  }
  return mapped;
}

function stringField(payload: unknown, field: string): string | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toTaskEnvelope(envelope: JobEnvelope): TaskEnvelope {
  return {
    taskId: stringField(envelope.payload, 'taskId') ?? envelope.jobId,
    teamId: envelope.teamId,
    ...(envelope.datasetId !== undefined ? { datasetId: envelope.datasetId } : {}),
    ...(envelope.collectionId !== undefined ? { collectionId: envelope.collectionId } : {}),
    ...(envelope.dataId !== undefined ? { dataId: envelope.dataId } : {}),
    mode: envelope.mode,
    payload: whitelistPayload(envelope.payload),
  };
}

/** 真实薄 handler：只做 payload → application 调用，业务状态变更回到 application。 */
export function createSourceCollectionJobHandler(
  deps: SourceCollectionJobHandlerDeps,
): SourceCollectionJobHandler {
  return {
    handle: (envelope, context) =>
      deps.trainingProcessor.process(toTaskEnvelope(envelope), context),
  };
}
