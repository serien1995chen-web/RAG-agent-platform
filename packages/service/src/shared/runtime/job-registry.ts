import { ApiErrorException, createApiError } from '@kb/contracts';
import { JOB_MODE_TO_QUEUE, QUEUE_NAMES } from '@kb/dal';
import type { TaskResult } from '../../ports/capabilities';
import type { JobDefinition, JobEnvelope, RequestContext } from '../../ports/types';
import { ConfigValidationException } from '../config/config-error';

/** Worker 场景 Port 调用默认超时（外部 I/O 必须显式声明超时）。 */
export const DEFAULT_JOB_PORT_TIMEOUT_MS = 30_000;

export interface LifecycleJobHandler {
  handle(envelope: JobEnvelope, context: RequestContext): Promise<TaskResult>;
}

export interface JobHandlerResolveRequest {
  requestId: string;
  taskId: string;
}

export interface JobHandlerRegistry {
  register(definition: JobDefinition, handler: LifecycleJobHandler): void;
  resolve(queue: string, mode: string, request: JobHandlerResolveRequest): LifecycleJobHandler;
  definitions(): readonly JobDefinition[];
}

const QUEUE_NAMES_SET: ReadonlySet<string> = new Set(Object.values(QUEUE_NAMES));

/**
 * 生命周期 Job Handler 注册表（P3-04）：校验与 P3-03 相同；
 * 重复 (queue, mode) → ConfigValidationException 启动失败；未注册组合 → 501005。
 */
export function createJobHandlerRegistry(): JobHandlerRegistry {
  const handlers = new Map<string, LifecycleJobHandler>();
  const definitions: JobDefinition[] = [];

  return {
    register(definition, handler) {
      const issues: string[] = [];
      if (!QUEUE_NAMES_SET.has(definition.queue)) {
        issues.push(`definition ${definition.name} 使用了契约外队列 ${definition.queue}`);
      }
      const keys: string[] = [];
      for (const mode of definition.modes) {
        const mapped = JOB_MODE_TO_QUEUE[mode];
        if (!mapped) {
          issues.push(`definition ${definition.name} 使用未登记 mode ${mode}`);
        } else if (mapped !== definition.queue) {
          issues.push(
            `definition ${definition.name} queue ${definition.queue} ≠ JOB_MODE_TO_QUEUE[${mode}]=${mapped}`,
          );
        }
        keys.push(`${definition.queue}:${mode}`);
      }
      for (const key of keys) {
        if (handlers.has(key)) issues.push(`重复注册 Job Handler：${key}`);
      }
      if (issues.length > 0) throw new ConfigValidationException(issues);
      definitions.push(definition);
      for (const key of keys) handlers.set(key, handler);
    },
    resolve(queue, mode, request) {
      const handler = handlers.get(`${queue}:${mode}`);
      if (!handler) {
        throw new ApiErrorException(
          createApiError({
            code: 501005,
            requestId: request.requestId,
            params: { taskId: request.taskId, from: mode, to: 'unregistered' },
          }),
        );
      }
      return handler;
    },
    definitions: () => definitions,
  };
}
