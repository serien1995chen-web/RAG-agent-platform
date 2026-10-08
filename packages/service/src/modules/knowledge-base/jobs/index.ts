import { QUEUE_NAMES } from '@kb/dal';
import type { DatasetSyncPort, TaskResult } from '../../../ports/capabilities';
import type { JobDefinition, JobEnvelope, RequestContext } from '../../../ports/types';
import {
  DEFAULT_JOB_PORT_TIMEOUT_MS,
  createJobHandlerRegistry,
} from '../../../shared/runtime/job-registry';

const DATASET_SYNC_DEFINITION: JobDefinition = {
  name: 'dataset-sync',
  queue: QUEUE_NAMES.sync,
  modes: ['sync'],
  stableIdTemplate: 'teamId:datasetId:sync',
};

export const KNOWLEDGE_BASE_JOB_DEFINITIONS: readonly JobDefinition[] = [DATASET_SYNC_DEFINITION];

export interface KnowledgeBaseJobHandler {
  handle(envelope: JobEnvelope, context: RequestContext): Promise<TaskResult>;
}

export interface KnowledgeBaseJobHandlerDeps {
  datasetSync: DatasetSyncPort;
}

/** payload 白名单（P3-04）：未识别字段一律丢弃。 */
const SYNC_PAYLOAD_FIELDS = ['datasetId', 'idempotencyKey'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function whitelistPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  const mapped: Record<string, unknown> = {};
  for (const field of SYNC_PAYLOAD_FIELDS) {
    if (payload[field] !== undefined) mapped[field] = payload[field];
  }
  return mapped;
}

/**
 * 真实薄 handler（P3-04）：白名单映射 {datasetId, idempotencyKey} 调用既有 DatasetSyncPort；
 * 501020（扩展未启用）等既有 ApiError 原样上抛，由 Worker 失败路径按分类器回写，不重包装。
 */
export function createKnowledgeBaseJobHandler(
  deps: KnowledgeBaseJobHandlerDeps,
): KnowledgeBaseJobHandler {
  const registry = createJobHandlerRegistry();
  registry.register(DATASET_SYNC_DEFINITION, {
    handle: async (envelope, context) => {
      const payload = whitelistPayload(envelope.payload);
      const datasetId =
        typeof payload['datasetId'] === 'string' && payload['datasetId'].length > 0
          ? payload['datasetId']
          : (envelope.datasetId ?? '');
      const idempotencyKey =
        typeof payload['idempotencyKey'] === 'string' && payload['idempotencyKey'].length > 0
          ? payload['idempotencyKey']
          : envelope.jobId;
      const result = await deps.datasetSync.sync(
        {
          datasetId,
          idempotencyKey,
          options: { timeoutMs: context.timeoutMs ?? DEFAULT_JOB_PORT_TIMEOUT_MS },
        },
        context,
      );
      if (result.state === 'error') {
        return { state: 'failed', errorMsg: result.errorMsg ?? 'dataset.sync.failed' };
      }
      return { state: 'success', producedItems: result.changed + result.removed };
    },
  });
  return {
    handle: async (envelope, context) =>
      registry
        .resolve(envelope.queue, envelope.mode, {
          requestId: context.requestId,
          taskId: envelope.jobId,
        })
        .handle(envelope, context),
  };
}
