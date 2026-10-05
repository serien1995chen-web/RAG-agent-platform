import { createUnimplementedPort } from '../../../ports/defaults';
import type { DeleteJobRepository } from '../../../ports/repositories';

/** Adapter 骨架：只封装外部系统访问，不得改变业务状态。 */
export function createDeleteJobAdapter(): DeleteJobRepository {
  return createUnimplementedPort<DeleteJobRepository>('DeleteJobRepository-adapter');
}
