import { createUnimplementedPort } from '../../../ports/defaults';
import type { MigrationRegistryPort } from '../../../ports/capabilities';

/** Repository 骨架：Phase 4 接入 Mongo/pgvector/全文实现，当前返回稳定未实现错误。 */
export function createMigrationRunRepository(): MigrationRegistryPort {
  return createUnimplementedPort<MigrationRegistryPort>('MigrationRegistryPort');
}
