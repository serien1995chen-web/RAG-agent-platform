import { createUnimplementedPort } from '../../../ports/defaults';
import type { JobDefinition, RequestContext } from '../../../ports/types';

export const KNOWLEDGE_ITEM_INDEX_JOB_DEFINITIONS: readonly JobDefinition[] = [
  {
    name: 'index-sync',
    queue: 'dataset-index',
    modes: ['chunk', 'qa'],
    stableIdTemplate: 'teamId:dataId:index:version',
  },
];

export interface KnowledgeItemIndexJobHandler {
  handle(payload: unknown, context: RequestContext): Promise<void>;
}

/** Job Handler 骨架：只做 payload 映射与租约处理，业务状态变更必须回到 application。 */
export function createKnowledgeItemIndexJobHandler(): KnowledgeItemIndexJobHandler {
  return createUnimplementedPort<KnowledgeItemIndexJobHandler>('KnowledgeItemIndexJobHandler');
}
