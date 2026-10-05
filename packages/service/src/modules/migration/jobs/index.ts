import { createUnimplementedPort } from '../../../ports/defaults';
import type { JobDefinition, RequestContext } from '../../../ports/types';

export const MIGRATION_RUN_JOB_DEFINITIONS: readonly JobDefinition[] = [
  {
    name: 'migration-run',
    queue: 'dataset-migration',
    modes: ['migration', 'reconcile'],
    stableIdTemplate: 'teamId:migrationId:batchId',
  },
];

export interface MigrationRunJobHandler {
  handle(payload: unknown, context: RequestContext): Promise<void>;
}

/** Job Handler 骨架：只做 payload 映射与租约处理，业务状态变更必须回到 application。 */
export function createMigrationRunJobHandler(): MigrationRunJobHandler {
  return createUnimplementedPort<MigrationRunJobHandler>('MigrationRunJobHandler');
}
