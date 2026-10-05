import { createUnimplementedPort } from '../../../ports/defaults';
import type { MigrationRegistryPort } from '../../../ports/capabilities';

/** Adapter 骨架：只封装外部系统访问，不得改变业务状态。 */
export function createMigrationRunAdapter(): MigrationRegistryPort {
  return createUnimplementedPort<MigrationRegistryPort>('MigrationRegistryPort-adapter');
}
