import { QUEUE_NAMES } from '@kb/dal';
import type { TaskResult } from '../../../ports/capabilities';
import type { DeleteJobRepository } from '../../../ports/repositories';
import type { JobDefinition, JobEnvelope, RequestContext } from '../../../ports/types';
import {
  DEFAULT_JOB_PORT_TIMEOUT_MS,
  createJobHandlerRegistry,
} from '../../../shared/runtime/job-registry';

const DELETE_CLEANUP_DEFINITION: JobDefinition = {
  name: 'delete-cleanup',
  queue: QUEUE_NAMES.delete,
  modes: ['delete'],
  stableIdTemplate: 'teamId:datasetId:delete',
};

export const DELETE_JOB_JOB_DEFINITIONS: readonly JobDefinition[] = [DELETE_CLEANUP_DEFINITION];

export interface DeleteJobJobHandler {
  handle(envelope: JobEnvelope, context: RequestContext): Promise<TaskResult>;
}

export interface DeleteJobJobHandlerDeps {
  deleteRepository: DeleteJobRepository;
}

/** payload 白名单（P3-04）：未识别字段一律丢弃。 */
const DELETE_PAYLOAD_FIELDS = ['jobId', 'scope', 'stage'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function whitelistPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  const mapped: Record<string, unknown> = {};
  for (const field of DELETE_PAYLOAD_FIELDS) {
    if (payload[field] !== undefined) mapped[field] = payload[field];
  }
  return mapped;
}

/**
 * 真实薄 handler（P3-04）：白名单映射 payload，读取/校验同租户事实后返回；
 * 清理状态机与业务动作留在后续实现；错误不吞、不重包装，交 Worker 按分类器回写。
 */
export function createDeleteJobJobHandler(deps: DeleteJobJobHandlerDeps): DeleteJobJobHandler {
  const registry = createJobHandlerRegistry();
  registry.register(DELETE_CLEANUP_DEFINITION, {
    handle: async (envelope, context) => {
      const mapped = whitelistPayload(envelope.payload);
      const jobId = typeof mapped['jobId'] === 'string' ? mapped['jobId'] : envelope.jobId;
      await deps.deleteRepository.get(
        { jobId, options: { timeoutMs: context.timeoutMs ?? DEFAULT_JOB_PORT_TIMEOUT_MS } },
        context,
      );
      return { state: 'success', producedItems: 0 };
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
