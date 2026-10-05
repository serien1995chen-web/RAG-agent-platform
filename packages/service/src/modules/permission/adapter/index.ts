import { createUnimplementedPort } from '../../../ports/defaults';
import type { DatasetPermissionPort } from '../../../ports/capabilities';

/** Adapter 骨架：只封装外部系统访问，不得改变业务状态。 */
export function createDatasetAclAdapter(): DatasetPermissionPort {
  return createUnimplementedPort<DatasetPermissionPort>('DatasetPermissionPort-adapter');
}
