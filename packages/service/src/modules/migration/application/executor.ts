import { ApiErrorException, createApiError } from '@kb/contracts';
import type {
  AuditPort,
  BackupToolPort,
  MigrationRegistryPort,
  MongoIndexManagerPort,
} from '../../../ports/capabilities';
import type { PortCallOptions, RequestContext } from '../../../ports/types';
import { scopeTeamId } from '../domain/registry';

export interface MigrationBatch {
  id: string;
  nextCursor: string;
  execute(
    input: { runId: string; cursor: string | null; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{
    counts: { expected: number; actual: number };
    references: { checked: number; missing: string[] };
    operation?: Record<string, unknown>;
  }>;
}

export interface MigrationDefinition {
  version: string;
  name: string;
  batches: readonly MigrationBatch[];
  writeMode: 'block' | 'readonly' | 'online';
  estimatedWindow: { minMs: number; maxMs: number };
  rollbackWindow: { minMs: number; maxMs: number };
  backupRequired: boolean;
  validate?: (
    input: { version: string; scope: unknown; options: PortCallOptions },
    context: RequestContext,
  ) => Promise<{ ok: boolean; findings?: unknown[] }>;
}

export interface MigrationExecutionResult {
  runId: string;
  cursor: string | null;
  state: string;
}

export const MIGRATION_DEFINITIONS: readonly MigrationDefinition[] = [
  {
    version: 'p7-framework-v1',
    name: 'P7 migration framework',
    batches: [],
    writeMode: 'online',
    estimatedWindow: { minMs: 0, maxMs: 0 },
    rollbackWindow: { minMs: 0, maxMs: 0 },
    backupRequired: false,
  },
];

export function registerMigrationDefinitions(
  definitions: readonly MigrationDefinition[] = MIGRATION_DEFINITIONS,
): ReadonlyMap<string, MigrationDefinition> {
  const registry = new Map<string, MigrationDefinition>();
  for (const definition of definitions) {
    if (registry.has(definition.version)) {
      throw new ApiErrorException(
        createApiError({
          code: 501025,
          requestId: 'migration-registry',
          params: { cursor: `duplicate:${definition.version}` },
        }),
      );
    }
    registry.set(definition.version, definition);
  }
  return registry;
}

interface MigrationExecutionRegistryPort extends MigrationRegistryPort {
  start(
    input: {
      definition: MigrationDefinition;
      scope: unknown;
      idempotencyKey: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ runId: string; cursor: string | null; state: string; replayed: boolean }>;
  progress(
    input: {
      runId: string;
      batchId: string;
      cursor: string;
      counts: { expected: number; actual: number };
      references: { checked: number; missing: string[] };
      operation?: Record<string, unknown>;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<void>;
  complete(
    input: {
      runId: string;
      cursor: string | null;
      counts: { expected: number; actual: number };
      references: { checked: number; missing: string[] };
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<void>;
  fail(
    input: {
      runId: string;
      cursor: string | null;
      error: Record<string, unknown>;
      failedResources: string[];
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<void>;
  markCancelled(
    input: {
      runId: string;
      rollbackInfo: Record<string, unknown>;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ state: string }>;
  resume(
    input: { runId: string; cursor: string; idempotencyKey: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ runId: string; cursor: string | null; state: string; version: string }>;
}

type MigrationExecutorDeps = {
  registry: MigrationExecutionRegistryPort;
  backupTool: BackupToolPort;
  mongoIndexManager: MongoIndexManagerPort;
  audit?: AuditPort;
  definitions?: readonly MigrationDefinition[];
};

function invalidCursor(requestId: string, cursor: string): ApiErrorException {
  return new ApiErrorException(createApiError({ code: 501025, requestId, params: { cursor } }));
}

function assertKnownDefinition(
  definitions: ReadonlyMap<string, MigrationDefinition>,
  version: string,
  requestId: string,
): MigrationDefinition {
  const definition = definitions.get(version);
  if (!definition) throw invalidCursor(requestId, version);
  return definition;
}

function assertScope(scope: unknown, context: RequestContext): void {
  if (scopeTeamId(scope) !== context.tenant.teamId) {
    throw new ApiErrorException(
      createApiError({
        code: 501025,
        requestId: context.requestId,
        params: { cursor: 'scope.teamId' },
      }),
    );
  }
}

function backupCommandOf(definition: MigrationDefinition, scope: unknown): Record<string, unknown> {
  const teamId = scopeTeamId(scope) ?? 'unknown';
  return {
    toolRef: `migration-backup:${definition.version}`,
    artifactRef: `dataset_migrations:${definition.version}`,
    changeId: `${definition.version}:${teamId}`,
  };
}

async function appendAudit(
  audit: AuditPort | undefined,
  input: {
    eventId: string;
    operation: string;
    resourceType: string;
    resourceId: string;
    payload: Record<string, unknown>;
  },
  context: RequestContext,
): Promise<void> {
  if (!audit) return;
  try {
    await audit.append(
      {
        eventId: input.eventId,
        teamId: context.tenant.teamId,
        actorTmbId: context.tenant.tmbId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        operation: input.operation,
        requestId: context.requestId,
        payload: input.payload,
      },
      context,
    );
  } catch {
    // Audit is best-effort for migration orchestration; a failure must not hide the migration result.
  }
}

export class MigrationExecutor {
  private readonly definitions: ReadonlyMap<string, MigrationDefinition>;

  constructor(private readonly deps: MigrationExecutorDeps) {
    this.definitions = registerMigrationDefinitions(deps.definitions ?? MIGRATION_DEFINITIONS);
  }

  async dryRun(
    input: { version: string; scope: unknown; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ diff: unknown; state: string }> {
    assertScope(input.scope, context);
    const definition = assertKnownDefinition(this.definitions, input.version, context.requestId);
    if (definition.validate) {
      const validation = await definition.validate(input, context);
      if (!validation.ok) {
        throw invalidCursor(context.requestId, `validation:${definition.version}`);
      }
    }
    const result = await this.deps.registry.dryRun(input, context);
    return {
      diff: {
        ...(typeof result.diff === 'object' && result.diff !== null ? result.diff : {}),
        version: definition.version,
        writeMode: definition.writeMode,
        estimatedWindow: definition.estimatedWindow,
        rollbackWindow: definition.rollbackWindow,
        backupRequired: definition.backupRequired,
        batches: definition.batches.map((batch) => batch.id),
      },
      state: 'dry_run',
    };
  }

  async apply(
    input: { version: string; scope: unknown; idempotencyKey: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<MigrationExecutionResult> {
    assertScope(input.scope, context);
    const definition = assertKnownDefinition(this.definitions, input.version, context.requestId);
    let backupVerified = !definition.backupRequired;
    if (definition.backupRequired) {
      const command = backupCommandOf(definition, input.scope);
      const validation = await this.deps.backupTool.validate(
        { command, options: input.options },
        context,
      );
      if (!validation.valid) throw invalidCursor(context.requestId, 'backup.validate');
      const run = await this.deps.backupTool.run({ command, options: input.options }, context);
      const verification = await this.deps.backupTool.verify(
        { evidence: run.evidence, options: input.options },
        context,
      );
      if (!verification.verified) throw invalidCursor(context.requestId, 'backup.verify');
      backupVerified = true;
    }

    const started = await this.deps.registry.start(
      {
        definition,
        scope: input.scope,
        idempotencyKey: input.idempotencyKey,
        options: input.options,
      },
      context,
    );
    await appendAudit(
      this.deps.audit,
      {
        eventId: `migration.apply.started:${started.runId}:${input.idempotencyKey}`,
        operation: 'migration.apply.started',
        resourceType: 'migration',
        resourceId: started.runId,
        payload: {
          version: definition.version,
          scope: input.scope,
          dryRun: false,
          result: 'running',
          requestId: context.requestId,
        },
      },
      context,
    );

    if (started.replayed && started.state !== 'running') {
      return { runId: started.runId, cursor: started.cursor, state: started.state };
    }

    const batches = await this.runBatches(
      { definition, runId: started.runId, cursor: started.cursor, options: input.options },
      context,
    );
    if (batches.state === 'failed') {
      return { runId: started.runId, cursor: batches.cursor, state: 'failed' };
    }
    if (
      !backupVerified ||
      !this.verifyCompletion({
        counts: batches.counts,
        references: batches.references,
        indexErrors: batches.indexErrors,
      })
    ) {
      await this.deps.registry.fail(
        {
          runId: started.runId,
          cursor: batches.cursor,
          error: { reason: 'completion_verification_failed' },
          failedResources: batches.references.missing,
          options: input.options,
        },
        context,
      );
      return { runId: started.runId, cursor: batches.cursor, state: 'failed' };
    }
    await this.deps.registry.complete(
      {
        runId: started.runId,
        cursor: batches.cursor,
        counts: batches.counts,
        references: batches.references,
        options: input.options,
      },
      context,
    );
    await appendAudit(
      this.deps.audit,
      {
        eventId: `migration.apply.done:${started.runId}`,
        operation: 'migration.apply.done',
        resourceType: 'migration',
        resourceId: started.runId,
        payload: { version: definition.version, dryRun: false, result: 'done', requestId: context.requestId },
      },
      context,
    );
    return { runId: started.runId, cursor: batches.cursor, state: 'done' };
  }

  private async runBatches(
    input: {
      definition: MigrationDefinition;
      runId: string;
      cursor: string | null;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{
    state: 'done' | 'failed';
    cursor: string | null;
    counts: { expected: number; actual: number };
    references: { checked: number; missing: string[] };
    indexErrors: string[];
  }> {
    let cursor = input.cursor;
    const counts = { expected: 0, actual: 0 };
    const references = { checked: 0, missing: [] as string[] };

    for (const batch of input.definition.batches) {
      if (cursor !== null && batch.nextCursor <= cursor) {
        continue;
      }
      try {
        const result = await batch.execute({ runId: input.runId, cursor, options: input.options }, context);
        counts.expected += result.counts.expected;
        counts.actual += result.counts.actual;
        references.checked += result.references.checked;
        references.missing.push(...result.references.missing);
        if (result.references.missing.length > 0 || result.counts.expected !== result.counts.actual) {
          await this.deps.registry.fail(
            {
              runId: input.runId,
              cursor,
              error: { batchId: batch.id, reason: 'count_or_reference_mismatch' },
              failedResources: result.references.missing,
              options: input.options,
            },
            context,
          );
          return { state: 'failed', cursor, counts, references, indexErrors: [] };
        }
        cursor = batch.nextCursor;
        await this.deps.registry.progress(
          {
            runId: input.runId,
            batchId: batch.id,
            cursor,
            counts: result.counts,
            references: result.references,
            ...(result.operation ? { operation: result.operation } : {}),
            options: input.options,
          },
          context,
        );
      } catch (error) {
        await this.deps.registry.fail(
          {
            runId: input.runId,
            cursor,
            error: {
              batchId: batch.id,
              message: error instanceof Error ? error.message : 'unknown_batch_error',
            },
            failedResources: [batch.id],
            options: input.options,
          },
          context,
        );
        return { state: 'failed', cursor, counts, references, indexErrors: [] };
      }
    }

    const indexDiff = await this.deps.mongoIndexManager.inspect(
      { collection: 'dataset_migrations', dryRun: true, options: input.options },
      context,
    );
    return {
      state: 'done',
      cursor,
      counts,
      references,
      indexErrors: indexDiff.errors,
    };
  }

  private verifyCompletion(input: {
    counts: { expected: number; actual: number };
    references: { checked: number; missing: string[] };
    indexErrors: string[];
  }): boolean {
    if (input.counts.expected !== input.counts.actual) return false;
    if (input.references.missing.length > 0) return false;
    if (input.indexErrors.length > 0) return false;
    return true;
  }

  async resume(
    input: { runId: string; cursor: string; idempotencyKey: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<MigrationExecutionResult> {
    const resumed = await this.deps.registry.resume(input, context);
    if (resumed.state === 'done') {
      return { runId: resumed.runId, cursor: resumed.cursor, state: resumed.state };
    }
    const definition = assertKnownDefinition(
      this.definitions,
      resumed.version,
      context.requestId,
    );
    const batches = await this.runBatches(
      { definition, runId: resumed.runId, cursor: resumed.cursor, options: input.options },
      context,
    );
    if (batches.state === 'failed') {
      return { runId: resumed.runId, cursor: batches.cursor, state: 'failed' };
    }
    if (
      !this.verifyCompletion({
        counts: batches.counts,
        references: batches.references,
        indexErrors: batches.indexErrors,
      })
    ) {
      await this.deps.registry.fail(
        {
          runId: resumed.runId,
          cursor: batches.cursor,
          error: { reason: 'completion_verification_failed' },
          failedResources: batches.references.missing,
          options: input.options,
        },
        context,
      );
      return { runId: resumed.runId, cursor: batches.cursor, state: 'failed' };
    }
    await this.deps.registry.complete(
      {
        runId: resumed.runId,
        cursor: batches.cursor,
        counts: batches.counts,
        references: batches.references,
        options: input.options,
      },
      context,
    );
    return { runId: resumed.runId, cursor: batches.cursor, state: 'done' };
  }

  async rollback(
    input: { runId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ state: string }> {
    const cancelled = await this.deps.registry.markCancelled(
      {
        runId: input.runId,
        rollbackInfo: {
          changeId: `migration.rollback:${input.runId}`,
          runbookUri: 'docs/runbooks/release-rollback.md',
          runbookVersion: 'v1',
          checks: ['before', 'after'],
          commands: ['review rollback runbook before execution'],
          comparedFields: ['state', 'cursor'],
          evidence: null,
        },
        options: input.options,
      },
      context,
    );
    return { state: cancelled.state === 'cancelled' ? 'rolled_back' : cancelled.state };
  }
}
