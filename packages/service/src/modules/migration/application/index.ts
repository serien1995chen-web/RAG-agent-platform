import type { RequestContext } from '../../../ports/types';
import type { MigrationRegistryPort } from '../../../ports/capabilities';
import type { PortCallOptions } from '../../../ports/types';

export interface MigrationServiceDeps {
  repository: MigrationRegistryPort;
}

/** MigrationRun 应用编排骨架：只依赖 Port，不直接拼装存储查询。 */
export class MigrationApplicationService {
  constructor(private readonly deps: MigrationServiceDeps) {}

  dryRunMigration(
    input: { version: string; scope: unknown; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ diff: unknown; state: string }> {
    return this.deps.repository.dryRun(input, context);
  }

  applyMigration(
    input: {
      version: string;
      scope: unknown;
      idempotencyKey: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ runId: string; cursor: string | null; state: string }> {
    return this.deps.repository.apply(input, context);
  }

  resumeMigration(
    input: {
      runId: string;
      cursor: string;
      idempotencyKey: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ runId: string; cursor: string | null; state: string }> {
    return this.deps.repository.resume(input, context);
  }

  rollbackMigration(
    input: { runId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ state: string }> {
    return this.deps.repository.rollback(input, context);
  }
}
