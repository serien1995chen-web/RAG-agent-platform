import { createUnimplementedPort } from '../../../ports/defaults';
import type { JobDefinition, RequestContext } from '../../../ports/types';

export const KNOWLEDGE_BASE_JOB_DEFINITIONS: readonly JobDefinition[] = [
  {
    name: 'dataset-sync',
    queue: 'dataset-sync',
    modes: ['sync'],
    stableIdTemplate: 'teamId:datasetId:sync',
  },
];

export interface KnowledgeBaseJobHandler {
  handle(payload: unknown, context: RequestContext): Promise<void>;
}

/** Job Handler 骨架：只做 payload 映射与租约处理，业务状态变更必须回到 application。 */
export function createKnowledgeBaseJobHandler(): KnowledgeBaseJobHandler {
  return createUnimplementedPort<KnowledgeBaseJobHandler>('KnowledgeBaseJobHandler');
}
