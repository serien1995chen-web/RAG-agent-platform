import { createUnimplementedPort } from '../../../ports/defaults';
import type { JobDefinition, RequestContext } from '../../../ports/types';

/**
 * P3-03（D2）：设计 12.10 的 Job 列表没有 Index 队列任务，9.9 将索引/全文写入并入
 * Vector 流程，因此目标状态为不注册任何队列任务（原骨架 `dataset-index` 不在队列契约内）。
 */
export const KNOWLEDGE_ITEM_INDEX_JOB_DEFINITIONS: readonly JobDefinition[] = [];

export interface KnowledgeItemIndexJobHandler {
  handle(payload: unknown, context: RequestContext): Promise<void>;
}

/** 索引投影 helper 工厂：保留给 Vector 流程内部调用，不注册任何队列。 */
export function createKnowledgeItemIndexJobHandler(): KnowledgeItemIndexJobHandler {
  return createUnimplementedPort<KnowledgeItemIndexJobHandler>('KnowledgeItemIndexJobHandler');
}
