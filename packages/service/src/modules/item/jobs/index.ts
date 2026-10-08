import { QUEUE_NAMES } from '@kb/dal';
import type { TaskEnvelope, TaskResult, TrainingProcessorPort } from '../../../ports/capabilities';
import type { JobDefinition, JobEnvelope, RequestContext } from '../../../ports/types';

/** P3-03：与 `PROCESSING_JOB_JOB_DEFINITIONS` 的 qa/vector 数值一致。 */
export const KNOWLEDGE_ITEM_JOB_DEFINITIONS: readonly JobDefinition[] = [
  {
    name: 'item-qa',
    queue: QUEUE_NAMES.qa,
    modes: ['qa'],
    stableIdTemplate: 'teamId:dataId:qa:version',
  },
  {
    name: 'item-vector',
    queue: QUEUE_NAMES.vector,
    modes: ['vector'],
    stableIdTemplate: 'teamId:dataId:vector:version',
  },
];

export interface KnowledgeItemJobHandler {
  handle(envelope: JobEnvelope, context: RequestContext): Promise<TaskResult>;
}

export interface KnowledgeItemJobHandlerDeps {
  trainingProcessor: TrainingProcessorPort;
}

/** payload 白名单（P3-03，与 collection 同口径）：未识别字段一律丢弃，禁止透传正文/密钥。 */
const ITEM_PAYLOAD_FIELDS = [
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
  for (const field of ITEM_PAYLOAD_FIELDS) {
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
export function createKnowledgeItemJobHandler(
  deps: KnowledgeItemJobHandlerDeps,
): KnowledgeItemJobHandler {
  return {
    handle: (envelope, context) =>
      deps.trainingProcessor.process(toTaskEnvelope(envelope), context),
  };
}
