import { createUnimplementedPort } from '../../../ports/defaults';
import type { JobDefinition, RequestContext } from '../../../ports/types';

export const DELETE_JOB_JOB_DEFINITIONS: readonly JobDefinition[] = [
  {
    name: 'delete-cleanup',
    queue: 'dataset-delete',
    modes: ['delete'],
    stableIdTemplate: 'teamId:datasetId:delete',
  },
];

export interface DeleteJobJobHandler {
  handle(payload: unknown, context: RequestContext): Promise<void>;
}

/** Job Handler 骨架：只做 payload 映射与租约处理，业务状态变更必须回到 application。 */
export function createDeleteJobJobHandler(): DeleteJobJobHandler {
  return createUnimplementedPort<DeleteJobJobHandler>('DeleteJobJobHandler');
}
