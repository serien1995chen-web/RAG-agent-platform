import type { PortCallOptions, RequestContext } from '../../../ports/types';
import type { MigrationExecutor } from './executor';

export interface MigrationServiceDeps {
  executor: MigrationExecutor;
}

/** P7-04 migration application facade: protocol mapping stays outside the executor. */
export class MigrationApplicationService {
  constructor(private readonly deps: MigrationServiceDeps) {}

  async dryRunMigration(
    input: { version: string; scope: unknown; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ report: unknown }> {
    const result = await this.deps.executor.dryRun(input, context);
    return { report: result.diff };
  }

  async applyMigration(
    input: {
      version: string;
      scope: unknown;
      idempotencyKey: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ runId: string }> {
    const result = await this.deps.executor.apply(input, context);
    return { runId: result.runId };
  }

  async resumeMigration(
    input: {
      runId: string;
      cursor: string;
      idempotencyKey: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ runId: string; cursor: string }> {
    const result = await this.deps.executor.resume(input, context);
    return { runId: result.runId, cursor: result.cursor ?? input.cursor };
  }

  async rollbackMigration(
    input: { runId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ state: string }> {
    return this.deps.executor.rollback(input, context);
  }
}
