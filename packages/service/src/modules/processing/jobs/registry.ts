import { ApiErrorException, createApiError } from '@kb/contracts';
import { JOB_MODE_TO_QUEUE, QUEUE_NAMES, type QueueName } from '@kb/dal';
import type { TaskResult } from '../../../ports/capabilities';
import type { JobDefinition, JobEnvelope, RequestContext } from '../../../ports/types';
import { ConfigValidationException } from '../../../shared/config/config-error';

/** P3-03 处理链注册集合（设计文档 12.10：parse/chunk/qa/vector）。 */
export const CHAIN_JOB_MODES = ['parse', 'chunk', 'qa', 'vector'] as const;
export type ChainJobMode = (typeof CHAIN_JOB_MODES)[number];

const QUEUE_NAMES_SET: ReadonlySet<string> = new Set(Object.values(QUEUE_NAMES));

function queueOfMode(mode: string): QueueName {
  const queue = JOB_MODE_TO_QUEUE[mode];
  if (!queue) throw new ConfigValidationException([`未登记的 Job mode：${mode}`]);
  return queue;
}

/** 契约对齐定义（D1/D3）：queue 取 JOB_MODE_TO_QUEUE，stableIdTemplate 取设计 12.10。 */
export const CHAIN_JOB_DEFINITIONS: readonly JobDefinition[] = [
  {
    name: 'processing-parse',
    queue: queueOfMode('parse'),
    modes: ['parse'],
    stableIdTemplate: 'teamId:datasetId:collectionId:parse:version',
  },
  {
    name: 'processing-chunk',
    queue: queueOfMode('chunk'),
    modes: ['chunk'],
    stableIdTemplate: 'teamId:datasetId:collectionId:chunk:version',
  },
  {
    name: 'processing-qa',
    queue: queueOfMode('qa'),
    modes: ['qa'],
    stableIdTemplate: 'teamId:dataId:qa:version',
  },
  {
    name: 'processing-vector',
    queue: queueOfMode('vector'),
    modes: ['vector'],
    stableIdTemplate: 'teamId:dataId:vector:version',
  },
];

export interface ChainJobHandler {
  handle(envelope: JobEnvelope, context: RequestContext): Promise<TaskResult>;
}

export interface ChainJobDispatchEntry {
  definition: JobDefinition;
  handler: ChainJobHandler;
}

export interface ChainJobResolveRequest {
  requestId: string;
  taskId: string;
}

export interface ChainJobDispatch {
  definitions(): readonly JobDefinition[];
  resolve(queue: string, mode: string, request: ChainJobResolveRequest): ChainJobHandler;
}

/** 定义必须落在队列契约内：queue ∈ QUEUE_NAMES 且 queue = JOB_MODE_TO_QUEUE[mode]。 */
export function assertContractAligned(definitions: readonly JobDefinition[]): void {
  const issues: string[] = [];
  for (const definition of definitions) {
    if (!QUEUE_NAMES_SET.has(definition.queue)) {
      issues.push(`definition ${definition.name} 使用了契约外队列 ${definition.queue}`);
    }
    for (const mode of definition.modes) {
      const mapped = JOB_MODE_TO_QUEUE[mode];
      if (!mapped) {
        issues.push(`definition ${definition.name} 使用未登记 mode ${mode}`);
      } else if (mapped !== definition.queue) {
        issues.push(
          `definition ${definition.name} queue ${definition.queue} ≠ JOB_MODE_TO_QUEUE[${mode}]=${mapped}`,
        );
      }
    }
  }
  if (issues.length > 0) throw new ConfigValidationException(issues);
}

/**
 * 处理链注册表：键 = `${queue}:${mode}`；重复注册启动失败；
 * 未注册 (queue, mode) 拒绝并复用既有错误码 501005。
 */
export function createChainJobDispatch(
  entries: readonly ChainJobDispatchEntry[],
): ChainJobDispatch {
  const handlers = new Map<string, ChainJobHandler>();
  const definitions: JobDefinition[] = [];
  for (const entry of entries) {
    assertContractAligned([entry.definition]);
    definitions.push(entry.definition);
    for (const mode of entry.definition.modes) {
      const key = `${entry.definition.queue}:${mode}`;
      if (handlers.has(key)) {
        throw new ConfigValidationException([`重复注册 Job Handler：${key}`]);
      }
      handlers.set(key, entry.handler);
    }
  }

  return {
    definitions: () => definitions,
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
  };
}
