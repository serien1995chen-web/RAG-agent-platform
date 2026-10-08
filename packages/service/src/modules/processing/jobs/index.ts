import type { TaskResult } from '../../../ports/capabilities';
import type { JobDefinition, JobEnvelope, RequestContext } from '../../../ports/types';
import { ConfigValidationException } from '../../../shared/config/config-error';
import { CHAIN_JOB_DEFINITIONS, createChainJobDispatch, type ChainJobHandler } from './registry';

/**
 * P3-03（D3）：处理链 4 条契约对齐定义（parse/chunk/qa/vector）。
 * 原骨架 `dataset-training` 队列不在队列契约内，按 D1 收敛。
 */
export const PROCESSING_JOB_JOB_DEFINITIONS: readonly JobDefinition[] = CHAIN_JOB_DEFINITIONS;

export interface ProcessingJobJobHandler {
  handle(envelope: JobEnvelope, context: RequestContext): Promise<TaskResult>;
}

export interface ProcessingJobJobHandlerDeps {
  handlersByMode: Readonly<Record<string, ChainJobHandler>>;
}

/**
 * 处理链组合分发器：按 (queue, mode) 唯一注册；重复注册启动失败；
 * 未注册组合抛 501005。claim/续租/提交由 Worker 装配层调用 application 完成。
 */
export function createProcessingJobJobHandler(
  deps: ProcessingJobJobHandlerDeps,
): ProcessingJobJobHandler {
  const dispatch = createChainJobDispatch(
    CHAIN_JOB_DEFINITIONS.map((definition) => {
      const mode = definition.modes[0] ?? '';
      const handler = deps.handlersByMode[mode];
      if (!handler) throw new ConfigValidationException([`缺少 mode=${mode} 的 Job Handler`]);
      return { definition, handler };
    }),
  );

  return {
    handle: async (envelope, context) =>
      dispatch
        .resolve(envelope.queue, envelope.mode, {
          requestId: context.requestId,
          taskId: envelope.jobId,
        })
        .handle(envelope, context),
  };
}
