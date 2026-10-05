import { createUnimplementedPort } from '../../../ports/defaults';
import type { JobDefinition, RequestContext } from '../../../ports/types';

export const PROCESSING_JOB_JOB_DEFINITIONS: readonly JobDefinition[] = [
  {
    name: 'training-claim',
    queue: 'dataset-training',
    modes: ['parse', 'chunk', 'qa', 'image', 'imageParse'],
    stableIdTemplate: 'teamId:datasetId:collectionId:mode:version',
  },
];

export interface ProcessingJobJobHandler {
  handle(payload: unknown, context: RequestContext): Promise<void>;
}

/** Job Handler 骨架：只做 payload 映射与租约处理，业务状态变更必须回到 application。 */
export function createProcessingJobJobHandler(): ProcessingJobJobHandler {
  return createUnimplementedPort<ProcessingJobJobHandler>('ProcessingJobJobHandler');
}
