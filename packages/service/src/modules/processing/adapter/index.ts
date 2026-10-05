import { createUnimplementedPort } from '../../../ports/defaults';
import type { ProcessingJobRepository } from '../../../ports/repositories';

/** Adapter 骨架：只封装外部系统访问，不得改变业务状态。 */
export function createProcessingJobAdapter(): ProcessingJobRepository {
  return createUnimplementedPort<ProcessingJobRepository>('ProcessingJobRepository-adapter');
}
