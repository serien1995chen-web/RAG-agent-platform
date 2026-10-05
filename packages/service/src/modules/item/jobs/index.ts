import { createUnimplementedPort } from '../../../ports/defaults';
import type { JobDefinition, RequestContext } from '../../../ports/types';

export const KNOWLEDGE_ITEM_JOB_DEFINITIONS: readonly JobDefinition[] = [
  {
    name: 'item-vector',
    queue: 'dataset-vector',
    modes: ['chunk', 'qa'],
    stableIdTemplate: 'teamId:dataId:vector:version',
  },
  {
    name: 'item-qa',
    queue: 'dataset-qa',
    modes: ['qa'],
    stableIdTemplate: 'teamId:dataId:qa:version',
  },
];

export interface KnowledgeItemJobHandler {
  handle(payload: unknown, context: RequestContext): Promise<void>;
}

/** Job Handler 骨架：只做 payload 映射与租约处理，业务状态变更必须回到 application。 */
export function createKnowledgeItemJobHandler(): KnowledgeItemJobHandler {
  return createUnimplementedPort<KnowledgeItemJobHandler>('KnowledgeItemJobHandler');
}
