import { createUnimplementedPort } from '../../../ports/defaults';
import type { JobDefinition, RequestContext } from '../../../ports/types';

export const SOURCE_COLLECTION_JOB_DEFINITIONS: readonly JobDefinition[] = [
  {
    name: 'collection-parse',
    queue: 'dataset-parse',
    modes: ['parse'],
    stableIdTemplate: 'teamId:datasetId:collectionId:parse:version',
  },
  {
    name: 'collection-chunk',
    queue: 'dataset-chunk',
    modes: ['chunk', 'auto'],
    stableIdTemplate: 'teamId:datasetId:collectionId:chunk:version',
  },
];

export interface SourceCollectionJobHandler {
  handle(payload: unknown, context: RequestContext): Promise<void>;
}

/** Job Handler 骨架：只做 payload 映射与租约处理，业务状态变更必须回到 application。 */
export function createSourceCollectionJobHandler(): SourceCollectionJobHandler {
  return createUnimplementedPort<SourceCollectionJobHandler>('SourceCollectionJobHandler');
}
