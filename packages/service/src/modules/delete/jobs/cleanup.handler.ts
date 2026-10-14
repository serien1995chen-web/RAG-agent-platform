import { classifyRetryableError } from '@kb/contracts';
import type { TaskResult } from '../../../ports/capabilities';
import type { JobEnvelope, RequestContext } from '../../../ports/types';
import { ConfigValidationException } from '../../../shared/config/config-error';
import {
  DEFAULT_JOB_PORT_TIMEOUT_MS,
  createJobHandlerRegistry,
} from '../../../shared/runtime/job-registry';
import type { DeleteCleanupStats, DeleteScope } from '../application/delete.service';
import { DELETE_JOB_JOB_DEFINITIONS } from './index';

/** 清理服务最小结构面（由 runtime.deleteService 提供）。 */
export interface DeleteCleanupService {
  runCleanup(
    input: {
      jobId: string;
      scope: DeleteScope;
      stage?: string;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<DeleteCleanupStats>;
}

export interface DeleteCleanupJobHandlerDeps {
  deleteService: DeleteCleanupService;
}

export interface DeleteCleanupJobHandler {
  handle(envelope: JobEnvelope, context: RequestContext): Promise<TaskResult>;
}

/** payload 白名单（P3-04）：未识别字段一律丢弃。 */
const DELETE_CLEANUP_PAYLOAD_FIELDS = ['jobId', 'scope', 'stage'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function whitelistPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  const mapped: Record<string, unknown> = {};
  for (const field of DELETE_CLEANUP_PAYLOAD_FIELDS) {
    if (payload[field] !== undefined) mapped[field] = payload[field];
  }
  return mapped;
}

function errorLabel(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 真实删除清理 handler（P6-01）：白名单映射 payload {jobId, scope, stage}，
 * 调用 DeleteApplicationService.runCleanup；失败分类交 Worker 处理器（不吞错、不重包装）。
 */
export function createDeleteCleanupJobHandler(
  deps: DeleteCleanupJobHandlerDeps,
): DeleteCleanupJobHandler {
  const [definition] = DELETE_JOB_JOB_DEFINITIONS;
  if (!definition) throw new ConfigValidationException(['缺少 delete Job 定义']);

  const registry = createJobHandlerRegistry();
  registry.register(definition, {
    handle: async (envelope, context) => {
      const mapped = whitelistPayload(envelope.payload);
      const jobId = typeof mapped['jobId'] === 'string' ? mapped['jobId'] : envelope.jobId;
      const scope = mapped['scope'];
      const stage = typeof mapped['stage'] === 'string' ? mapped['stage'] : undefined;
      const options = { timeoutMs: context.timeoutMs ?? DEFAULT_JOB_PORT_TIMEOUT_MS };
      try {
        const result = await deps.deleteService.runCleanup(
          {
            jobId,
            scope: scope as DeleteScope,
            ...(stage !== undefined ? { stage } : {}),
            options,
          },
          context,
        );
        if (result.failed > 0 || result.errorMsg !== undefined) {
          return {
            state: 'failed',
            ...(result.errorMsg !== undefined ? { errorMsg: result.errorMsg } : {}),
          };
        }
        return { state: 'success', producedItems: result.deleted };
      } catch (error) {
        const retryable = classifyRetryableError(error) === 'retryable';
        return {
          state: retryable ? 'retry' : 'failed',
          errorMsg: errorLabel(error),
        };
      }
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
