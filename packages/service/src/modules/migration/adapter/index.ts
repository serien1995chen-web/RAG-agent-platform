import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Connection, type Model } from 'mongoose';
import type { MigrationRegistryPort } from '../../../ports/capabilities';
import type { PortCallOptions, RequestContext } from '../../../ports/types';
import {
  DatasetMigrationLogSchema,
  DatasetMigrationSchema,
  type DatasetMigrationDoc,
  type DatasetMigrationLogDoc,
} from '../../../shared/persistence/schemas';
import type { MigrationDefinition, NormalizedMigrationScope } from '../application/executor';

const STALE_RUN_FLOOR_MS = 60_000;

function invalidCursor(requestId: string, cursor: string): ApiErrorException {
  return new ApiErrorException(createApiError({ code: 501025, requestId, params: { cursor } }));
}

function assertCursorAdvances(current: string | null, next: string, requestId: string): void {
  if (current !== null && next <= current) throw invalidCursor(requestId, next);
}

function busy(requestId: string, migrationId: string, scope: unknown): ApiErrorException {
  return new ApiErrorException(
    createApiError({ code: 501024, requestId, params: { migrationId, scope } }),
  );
}

function notFound(requestId: string, runId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501070,
      requestId,
      params: { resourceType: 'migration', resourceId: runId },
    }),
  );
}

function assertRunId(runId: string, requestId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(runId)) throw notFound(requestId, runId);
  return new Types.ObjectId(runId);
}

function idempotencyKeyOf(doc: Pick<DatasetMigrationDoc, 'resumeToken'>): string | null {
  const value = doc.resumeToken?.idempotencyKey;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function cursorOf(doc: Pick<DatasetMigrationDoc, 'resumeToken'>): string | null {
  const value = doc.resumeToken?.cursor;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function backupRequiredOf(
  doc: Pick<DatasetMigrationDoc, 'backupRequired' | 'resumeToken'>,
): boolean {
  const value = doc.resumeToken?.backupRequired;
  return typeof value === 'boolean' ? value : doc.backupRequired;
}

function backupVerifiedOf(doc: Pick<DatasetMigrationDoc, 'resumeToken'>): boolean {
  return doc.resumeToken?.backupVerified === true;
}

function idOf(doc: DatasetMigrationDoc): string {
  return String((doc as { _id?: unknown })._id ?? '');
}

function normalizedScopeOf(scope: unknown): NormalizedMigrationScope {
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
    throw new ApiErrorException(
      createApiError({
        code: 501025,
        requestId: 'migration-scope',
        params: { cursor: 'scope.canonical' },
      }),
    );
  }
  const value = scope as Record<string, unknown>;
  if (!Array.isArray(value.teamIds) || 'teamId' in value) {
    throw new ApiErrorException(
      createApiError({
        code: 501025,
        requestId: 'migration-scope',
        params: { cursor: 'scope.canonical' },
      }),
    );
  }
  return value as unknown as NormalizedMigrationScope;
}

function sameScope(left: unknown, right: NormalizedMigrationScope): boolean {
  if (typeof left !== 'object' || left === null) return false;
  const value = left as Record<string, unknown>;
  const fields = ['teamIds', 'datasetIds', 'collectionIds', 'operationTypes'] as const;
  return fields.every(
    (field) => JSON.stringify(value[field] ?? []) === JSON.stringify(right[field]),
  );
}

/** Mongo execution ledger for P7 migration runs. It never writes business collections. */
export class MigrationExecutionRegistry implements MigrationRegistryPort {
  private readonly model: Model<DatasetMigrationDoc>;
  private readonly logs: Model<DatasetMigrationLogDoc>;

  constructor(connection: Connection) {
    this.model =
      (connection.models.DatasetMigration as Model<DatasetMigrationDoc> | undefined) ??
      connection.model<DatasetMigrationDoc>('DatasetMigration', DatasetMigrationSchema);
    this.logs =
      (connection.models.DatasetMigrationLog as Model<DatasetMigrationLogDoc> | undefined) ??
      connection.model<DatasetMigrationLogDoc>('DatasetMigrationLog', DatasetMigrationLogSchema);
  }

  private runQuery(
    objectId: Types.ObjectId,
    context: RequestContext,
  ): { _id: Types.ObjectId; 'scope.teamIds'?: string } {
    return {
      _id: objectId,
      ...(!context.tenant.isRoot ? { 'scope.teamIds': context.tenant.teamId.toLowerCase() } : {}),
    };
  }

  async dryRun(
    input: { version: string; scope: unknown; options: PortCallOptions },
    _context: RequestContext,
  ): Promise<{ diff: unknown; state: string }> {
    return { diff: { version: input.version, scope: input.scope }, state: 'dry_run' };
  }

  async start(
    input: {
      definition: MigrationDefinition;
      scope: unknown;
      idempotencyKey: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{
    runId: string;
    cursor: string | null;
    state: string;
    scope: NormalizedMigrationScope;
    backupRequired: boolean;
    backupVerified: boolean;
    replayed: boolean;
  }> {
    const scope = normalizedScopeOf(input.scope);
    const existing = await this.model
      .findOne({ version: input.definition.version })
      .lean<DatasetMigrationDoc>();
    if (existing) {
      if (idempotencyKeyOf(existing) === input.idempotencyKey && sameScope(existing.scope, scope)) {
        return {
          runId: idOf(existing),
          cursor: cursorOf(existing),
          state: existing.state,
          scope: normalizedScopeOf(existing.scope),
          backupRequired: backupRequiredOf(existing),
          backupVerified: backupVerifiedOf(existing),
          replayed: true,
        };
      }
      throw busy(context.requestId, input.definition.version, scope);
    }

    const now = new Date();
    try {
      const doc = await this.model.create({
        version: input.definition.version,
        name: input.definition.name,
        state: 'running',
        attempts: 1,
        dryRun: false,
        resumeToken: {
          cursor: null,
          idempotencyKey: input.idempotencyKey,
          backupRequired: input.definition.backupRequired,
          backupVerified: !input.definition.backupRequired,
          backupEvidence: null,
        },
        rollbackInfo: null,
        error: null,
        scope: scope as unknown as Record<string, unknown>,
        writeMode: input.definition.writeMode,
        estimatedWindow: input.definition.estimatedWindow,
        rollbackWindow: input.definition.rollbackWindow,
        backupRequired: input.definition.backupRequired,
        createdBy: context.tenant.tmbId,
        createTime: now,
        updateTime: now,
      } as DatasetMigrationDoc);
      return {
        runId: String(doc._id),
        cursor: null,
        state: 'running',
        scope,
        backupRequired: input.definition.backupRequired,
        backupVerified: !input.definition.backupRequired,
        replayed: false,
      };
    } catch {
      const raced = await this.model
        .findOne({ version: input.definition.version })
        .lean<DatasetMigrationDoc>();
      if (
        raced &&
        idempotencyKeyOf(raced) === input.idempotencyKey &&
        sameScope(raced.scope, scope)
      ) {
        return {
          runId: idOf(raced),
          cursor: cursorOf(raced),
          state: raced.state,
          scope: normalizedScopeOf(raced.scope),
          backupRequired: backupRequiredOf(raced),
          backupVerified: backupVerifiedOf(raced),
          replayed: true,
        };
      }
      throw busy(context.requestId, input.definition.version, scope);
    }
  }

  async markBackupVerified(
    input: { runId: string; evidence: unknown; options: PortCallOptions },
    context: RequestContext,
  ): Promise<void> {
    const objectId = assertRunId(input.runId, context.requestId);
    const current = await this.model
      .findOne(this.runQuery(objectId, context))
      .lean<DatasetMigrationDoc>();
    if (!current) throw notFound(context.requestId, input.runId);
    if (!backupRequiredOf(current)) return;
    await this.model.updateOne(
      { ...this.runQuery(objectId, context), backupRequired: true },
      {
        $set: {
          resumeToken: {
            ...(current.resumeToken ?? {}),
            backupRequired: true,
            backupVerified: true,
            backupEvidence: input.evidence,
          },
          updateTime: new Date(),
        },
      },
    );
  }

  async apply(
    input: {
      version: string;
      scope: unknown;
      idempotencyKey: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ runId: string; cursor: string | null; state: string }> {
    const started = await this.start(
      {
        definition: {
          version: input.version,
          name: `migration:${input.version}`,
          batches: [],
          writeMode: 'online',
          estimatedWindow: { minMs: 0, maxMs: 0 },
          rollbackWindow: { minMs: 0, maxMs: 0 },
          backupRequired: false,
        },
        scope: input.scope,
        idempotencyKey: input.idempotencyKey,
        options: input.options,
      },
      context,
    );
    return { runId: started.runId, cursor: started.cursor, state: started.state };
  }

  async progress(
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
  ): Promise<void> {
    const objectId = assertRunId(input.runId, context.requestId);
    const current = await this.model
      .findOne(this.runQuery(objectId, context))
      .lean<DatasetMigrationDoc>();
    if (!current) throw notFound(context.requestId, input.runId);
    assertCursorAdvances(cursorOf(current), input.cursor, context.requestId);
    await this.model.updateOne(
      { ...this.runQuery(objectId, context), state: 'running' },
      {
        $set: {
          'resumeToken.cursor': input.cursor,
          updateTime: new Date(),
        },
      },
    );
    await this.writeLog(
      {
        runId: input.runId,
        version: current.version,
        batchId: input.batchId,
        cursor: input.cursor,
        state: 'running',
        counts: input.counts,
        references: input.references,
        operation: input.operation ?? null,
        error: null,
        rollbackInfo: null,
      },
      context,
    );
  }

  async complete(
    input: {
      runId: string;
      cursor: string | null;
      counts: { expected: number; actual: number };
      references: { checked: number; missing: string[] };
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<void> {
    if (input.counts.expected !== input.counts.actual || input.references.missing.length > 0) {
      throw invalidCursor(context.requestId, 'completion_verification');
    }
    const objectId = assertRunId(input.runId, context.requestId);
    const current = await this.model
      .findOne(this.runQuery(objectId, context))
      .lean<DatasetMigrationDoc>();
    if (!current) throw notFound(context.requestId, input.runId);
    if (backupRequiredOf(current) && !backupVerifiedOf(current)) {
      throw invalidCursor(context.requestId, 'backup.verify');
    }
    await this.model.updateOne(
      { ...this.runQuery(objectId, context), state: 'running' },
      {
        $set: {
          state: 'done',
          'resumeToken.cursor': input.cursor,
          error: null,
          updateTime: new Date(),
        },
      },
    );
    await this.writeLog(
      {
        runId: input.runId,
        version: current.version,
        batchId: 'complete',
        cursor: input.cursor,
        state: 'done',
        counts: input.counts,
        references: input.references,
        operation: null,
        error: null,
        rollbackInfo: null,
      },
      context,
    );
  }

  async fail(
    input: {
      runId: string;
      cursor: string | null;
      error: Record<string, unknown>;
      failedResources: string[];
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<void> {
    const objectId = assertRunId(input.runId, context.requestId);
    const current = await this.model
      .findOne(this.runQuery(objectId, context))
      .lean<DatasetMigrationDoc>();
    if (!current) throw notFound(context.requestId, input.runId);
    await this.model.updateOne(
      { ...this.runQuery(objectId, context), state: 'running' },
      {
        $set: {
          state: 'failed',
          error: input.error,
          'resumeToken.cursor': input.cursor,
          updateTime: new Date(),
        },
      },
    );
    await this.writeLog(
      {
        runId: input.runId,
        version: current.version,
        batchId: 'failed',
        cursor: input.cursor,
        state: 'failed',
        counts: { expected: 0, actual: 0 },
        references: { checked: 0, missing: input.failedResources },
        operation: null,
        error: input.error,
        rollbackInfo: null,
      },
      context,
    );
  }

  async resume(
    input: { runId: string; cursor: string; idempotencyKey: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{
    runId: string;
    cursor: string | null;
    state: string;
    scope: NormalizedMigrationScope;
    backupRequired: boolean;
    backupVerified: boolean;
    version: string;
  }> {
    const objectId = assertRunId(input.runId, context.requestId);
    const current = await this.model
      .findOne(this.runQuery(objectId, context))
      .lean<DatasetMigrationDoc>();
    if (!current) throw notFound(context.requestId, input.runId);
    const backupRequired = backupRequiredOf(current);
    const backupVerified = backupVerifiedOf(current);
    if (current.state === 'done') {
      if (backupRequired && !backupVerified) {
        throw invalidCursor(context.requestId, 'backup.verify');
      }
      assertCursorAdvances(cursorOf(current), input.cursor, context.requestId);
      return {
        runId: idOf(current),
        cursor: cursorOf(current),
        state: current.state,
        scope: normalizedScopeOf(current.scope),
        backupRequired,
        backupVerified,
        version: current.version,
      };
    }
    if (current.state === 'cancelled') throw invalidCursor(context.requestId, input.cursor);
    if (current.state === 'running') {
      const staleBefore = new Date(
        Date.now() - Math.max(input.options.timeoutMs, STALE_RUN_FLOOR_MS),
      );
      if (current.updateTime > staleBefore) {
        throw busy(context.requestId, current.version, current.scope);
      }
    }
    assertCursorAdvances(cursorOf(current), input.cursor, context.requestId);
    const updated = await this.model
      .findOneAndUpdate(
        {
          ...this.runQuery(objectId, context),
          state: { $in: ['failed', 'running'] },
        },
        {
          $set: {
            state: 'running',
            'resumeToken.cursor': input.cursor,
            'resumeToken.idempotencyKey': input.idempotencyKey,
            updateTime: new Date(),
          },
          $inc: { attempts: 1 },
        },
        { new: true },
      )
      .lean<DatasetMigrationDoc>();
    if (!updated) throw invalidCursor(context.requestId, input.cursor);
    return {
      runId: idOf(updated),
      cursor: cursorOf(updated),
      state: updated.state,
      scope: normalizedScopeOf(updated.scope),
      backupRequired: backupRequiredOf(updated),
      backupVerified: backupVerifiedOf(updated),
      version: updated.version,
    };
  }

  async markCancelled(
    input: { runId: string; rollbackInfo: Record<string, unknown>; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ state: string }> {
    const objectId = assertRunId(input.runId, context.requestId);
    const current = await this.model
      .findOne(this.runQuery(objectId, context))
      .lean<DatasetMigrationDoc>();
    if (!current) throw notFound(context.requestId, input.runId);
    if (current.state === 'cancelled') return { state: current.state };
    if (current.state !== 'failed') throw invalidCursor(context.requestId, current.state);
    await this.model.updateOne(
      { ...this.runQuery(objectId, context), state: 'failed' },
      { $set: { state: 'cancelled', rollbackInfo: input.rollbackInfo, updateTime: new Date() } },
    );
    return { state: 'cancelled' };
  }

  async rollback(
    input: { runId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ state: string }> {
    return this.markCancelled(
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
  }

  private async writeLog(
    input: {
      runId: string;
      version: string;
      batchId: string;
      cursor: string | null;
      state: string;
      counts: { expected: number; actual: number };
      references: { checked: number; missing: string[] };
      operation: Record<string, unknown> | null;
      error: Record<string, unknown> | null;
      rollbackInfo: Record<string, unknown> | null;
    },
    context: RequestContext,
  ): Promise<void> {
    const now = new Date();
    await this.logs.findOneAndUpdate(
      {
        migrationId: input.runId,
        batchId: input.batchId,
        teamId: new Types.ObjectId(context.tenant.teamId),
      },
      {
        $setOnInsert: {
          migrationId: input.runId,
          version: input.version,
          batchId: input.batchId,
          teamId: new Types.ObjectId(context.tenant.teamId),
          resourceRef: { resourceType: 'migration', resourceId: input.runId, version: 1 },
          dataId: null,
          attempts: 1,
          operations: {
            cursor: input.cursor,
            counts: input.counts,
            references: input.references,
            operation: input.operation,
          },
          error: input.error,
          rollbackInfo: input.rollbackInfo,
          createTime: now,
        },
        $set: { updateTime: now, state: input.state },
      },
      { upsert: true, new: true },
    );
  }
}

export function createMigrationRunAdapter(input: {
  connection: Connection;
}): MigrationExecutionRegistry {
  return new MigrationExecutionRegistry(input.connection);
}
