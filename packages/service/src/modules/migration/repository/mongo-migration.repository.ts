import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Connection, type Model } from 'mongoose';
import type { MigrationRegistryPort } from '../../../ports/capabilities';
import type { RequestContext } from '../../../ports/types';
import {
  DatasetMigrationLogSchema,
  DatasetMigrationSchema,
  type DatasetMigrationDoc,
  type DatasetMigrationLogDoc,
} from '../../../shared/persistence/schemas';
import { assertResumeCursor, assertScopeTenant } from '../domain/registry';

export interface MigrationLogInput {
  migrationId: string;
  version: string;
  batchId: string;
  resourceRef: { resourceType: string; resourceId: string; version: number };
  dataId?: string | null;
  state: string;
  attempts?: number;
  operations?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  rollbackInfo?: Record<string, unknown> | null;
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

export class MongoMigrationRepository implements MigrationRegistryPort {
  private readonly model: Model<DatasetMigrationDoc>;
  private readonly logs: Model<DatasetMigrationLogDoc>;

  constructor(connection: Connection) {
    this.model =
      (connection.models.DatasetMigration as Model<DatasetMigrationDoc>) ??
      connection.model<DatasetMigrationDoc>('DatasetMigration', DatasetMigrationSchema);
    this.logs =
      (connection.models.DatasetMigrationLog as Model<DatasetMigrationLogDoc>) ??
      connection.model<DatasetMigrationLogDoc>('DatasetMigrationLog', DatasetMigrationLogSchema);
  }

  async dryRun(
    input: { version: string; scope: unknown; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ diff: unknown; state: string }> {
    assertScopeTenant(input.scope, context.tenant.teamId, context.requestId);
    return { diff: { version: input.version, scope: input.scope }, state: 'dry_run' };
  }

  async apply(
    input: {
      version: string;
      scope: unknown;
      idempotencyKey: string;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ runId: string; cursor: string | null; state: string }> {
    assertScopeTenant(input.scope, context.tenant.teamId, context.requestId);
    if (!input.idempotencyKey) {
      throw new ApiErrorException(
        createApiError({
          code: 501005,
          requestId: context.requestId,
          params: { taskId: '', from: 'apply', to: 'missing_idempotency_key' },
        }),
      );
    }
    try {
      const now = new Date();
      const doc = await this.model.create({
        version: input.version,
        name: `migration:${input.version}`,
        state: 'running',
        attempts: 1,
        dryRun: false,
        resumeToken: { cursor: null },
        rollbackInfo: null,
        error: null,
        scope: input.scope as Record<string, unknown>,
        writeMode: 'online',
        estimatedWindow: null,
        rollbackWindow: null,
        backupRequired: false,
        createdBy: context.tenant.tmbId,
        createTime: now,
        updateTime: now,
      } as DatasetMigrationDoc);
      return { runId: String(doc._id), cursor: null, state: 'running' };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      throw new ApiErrorException(
        createApiError({
          code: 501005,
          requestId: context.requestId,
          params: { taskId: input.version, from: 'pending', to: 'running' },
        }),
      );
    }
  }

  async resume(
    input: {
      runId: string;
      cursor: string;
      idempotencyKey: string;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ runId: string; cursor: string | null; state: string }> {
    if (!Types.ObjectId.isValid(input.runId)) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'migration', resourceId: input.runId },
        }),
      );
    }
    const current = await this.model
      .findOne({
        _id: new Types.ObjectId(input.runId),
        'scope.teamId': context.tenant.teamId,
      })
      .lean();
    if (!current) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'migration', resourceId: input.runId },
        }),
      );
    }
    const currentCursor =
      typeof current.resumeToken?.cursor === 'string' ? current.resumeToken.cursor : null;
    assertResumeCursor(currentCursor, input.cursor, context.requestId);
    const updated = await this.model
      .findOneAndUpdate(
        { _id: current._id, 'scope.teamId': context.tenant.teamId },
        {
          $set: {
            state: 'running',
            resumeToken: { cursor: input.cursor, idempotencyKey: input.idempotencyKey },
            updateTime: new Date(),
          },
        },
        { new: true },
      )
      .lean();
    return {
      runId: String(updated?._id),
      cursor: String(updated?.resumeToken?.cursor ?? input.cursor),
      state: String(updated?.state ?? 'running'),
    };
  }

  async rollback(
    input: { runId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ state: string }> {
    if (!Types.ObjectId.isValid(input.runId)) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'migration', resourceId: input.runId },
        }),
      );
    }
    const updated = await this.model
      .findOneAndUpdate(
        { _id: new Types.ObjectId(input.runId), 'scope.teamId': context.tenant.teamId },
        {
          $set: {
            state: 'cancelled',
            rollbackInfo: { requestedBy: context.tenant.tmbId },
            updateTime: new Date(),
          },
        },
        { new: true },
      )
      .lean();
    if (!updated) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'migration', resourceId: input.runId },
        }),
      );
    }
    return { state: updated.state };
  }

  async writeLog(input: MigrationLogInput, context: RequestContext): Promise<void> {
    const now = new Date();
    await this.logs.findOneAndUpdate(
      {
        teamId: new Types.ObjectId(context.tenant.teamId),
        migrationId: input.migrationId,
        ...(input.dataId ? { dataId: input.dataId } : {}),
        ...(input.dataId
          ? {}
          : { batchId: input.batchId, 'resourceRef.resourceId': input.resourceRef.resourceId }),
      },
      {
        $setOnInsert: {
          migrationId: input.migrationId,
          version: input.version,
          batchId: input.batchId,
          teamId: new Types.ObjectId(context.tenant.teamId),
          resourceRef: input.resourceRef,
          dataId: input.dataId ?? null,
          state: input.state,
          attempts: input.attempts ?? 1,
          operations: input.operations ?? null,
          error: input.error ?? null,
          rollbackInfo: input.rollbackInfo ?? null,
          createTime: now,
        },
        $set: { updateTime: now },
      },
      { upsert: true, new: true },
    );
  }

  async listLogs(
    input: { migrationId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<DatasetMigrationLogDoc[]> {
    return this.logs
      .find({
        migrationId: input.migrationId,
        teamId: new Types.ObjectId(context.tenant.teamId),
      })
      .sort({ createTime: 1 })
      .lean();
  }
}
