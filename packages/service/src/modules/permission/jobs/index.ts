import { createUnimplementedPort } from '../../../ports/defaults';
import type { JobDefinition, RequestContext } from '../../../ports/types';

export const DATASET_ACL_JOB_DEFINITIONS: readonly JobDefinition[] = [
  {
    name: 'acl-materialize',
    queue: 'dataset-acl',
    modes: ['acl'],
    stableIdTemplate: 'teamId:datasetId:acl:version',
  },
];

export interface DatasetAclJobHandler {
  handle(payload: unknown, context: RequestContext): Promise<void>;
}

/** Job Handler 骨架：只做 payload 映射与租约处理，业务状态变更必须回到 application。 */
export function createDatasetAclJobHandler(): DatasetAclJobHandler {
  return createUnimplementedPort<DatasetAclJobHandler>('DatasetAclJobHandler');
}
