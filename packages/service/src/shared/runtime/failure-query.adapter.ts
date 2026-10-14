import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Connection, type Model, type Schema } from 'mongoose';
import type { FailureQueryPort, FailureRecord } from '../../ports/capabilities';
import type { PageResult, PortCallOptions, RequestContext } from '../../ports/types';
import {
  DatasetDeleteFailureSchema,
  DatasetMigrationLogSchema,
  DatasetTrainingSchema,
  OperationLogSchema,
  type DatasetDeleteFailureDoc,
  type DatasetMigrationLogDoc,
  type DatasetTrainingDoc,
  type OperationLogDoc,
} from '../persistence/schemas';

export interface FailureQueryAdapterDeps {
  connection: Connection;
}

interface Candidate {
  timeMs: number;
  sourceRank: number;
  idHex: string;
  errorClass: string;
  record: FailureRecord;
}

interface FailureCursor {
  timeMs: number;
  sourceRank: number;
  idHex: string;
}

type LeanDoc<T> = T & { _id: Types.ObjectId };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidScope(requestId: string, resourceType: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({ code: 501070, requestId, params: { resourceType, resourceId: '' } }),
  );
}

function toMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (value instanceof Date) return value.getTime();
  return undefined;
}

function parseCursor(cursor: string | undefined): FailureCursor | null {
  if (cursor === undefined) return null;
  const match = /^(\d+):(\d+):([0-9a-fA-F]{24})$/.exec(cursor);
  if (!match) return null;
  const [, timeText, rankText, idHex] = match;
  if (timeText === undefined || rankText === undefined || idHex === undefined) return null;
  return { timeMs: Number(timeText), sourceRank: Number(rankText), idHex };
}

function cursorKey(candidate: Candidate): string {
  return `${candidate.timeMs}:${candidate.sourceRank}:${candidate.idHex}`;
}

/** 全序：(time desc, sourceRank asc, _id desc)；返回 >0 表示 a 排在 b 之后。 */
function compareCandidate(a: Candidate, b: Candidate): number {
  if (a.timeMs !== b.timeMs) return b.timeMs - a.timeMs;
  if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank;
  if (a.idHex === b.idHex) return 0;
  return a.idHex < b.idHex ? 1 : -1;
}

function asCursor(cursor: FailureCursor): Candidate {
  return {
    timeMs: cursor.timeMs,
    sourceRank: cursor.sourceRank,
    idHex: cursor.idHex,
    errorClass: '',
    record: { resourceType: '', resourceId: '', reason: '', retryable: false },
  };
}

function resolveModel<T>(connection: Connection, name: string, schema: Schema<T>): Model<T> {
  const existing = connection.models[name] as Model<T> | undefined;
  return existing ?? connection.model<T>(name, schema);
}

/**
 * 设计 20.1 / D2-A：失败查询 Port 聚合读（只读，不写回源状态、不改变保留策略）。
 * 四源归并（sourceRank 固定）：dataset_delete_failures(0) / dataset_trainings(1) /
 * dataset_migration_logs(2) / operation_logs(3)；严格 teamId 谓词（Root 需显式 scope.teamId），
 * 支持 resourceType / resourceId / time / errorClass 过滤与 cursor 分页。
 */
export class FailureQueryAdapter implements FailureQueryPort {
  private readonly deleteFailures: Model<DatasetDeleteFailureDoc>;
  private readonly trainings: Model<DatasetTrainingDoc>;
  private readonly migrationLogs: Model<DatasetMigrationLogDoc>;
  private readonly operationLogs: Model<OperationLogDoc>;

  constructor(deps: FailureQueryAdapterDeps) {
    const connection = deps.connection;
    this.deleteFailures = resolveModel(
      connection,
      'DatasetDeleteFailure',
      DatasetDeleteFailureSchema,
    );
    this.trainings = resolveModel(connection, 'DatasetTraining', DatasetTrainingSchema);
    this.migrationLogs = resolveModel(connection, 'DatasetMigrationLog', DatasetMigrationLogSchema);
    this.operationLogs = resolveModel(connection, 'OperationLog', OperationLogSchema);
  }

  async query(
    input: { scope: unknown; cursor?: string; limit: number; options: PortCallOptions },
    context: RequestContext,
  ): Promise<PageResult<FailureRecord>> {
    const scope = isRecord(input.scope) ? input.scope : {};
    const scopeTeamId = typeof scope['teamId'] === 'string' ? scope['teamId'] : undefined;
    const teamIdValue = context.tenant.isRoot ? scopeTeamId : context.tenant.teamId;
    if (teamIdValue === undefined || !Types.ObjectId.isValid(teamIdValue)) {
      throw invalidScope(context.requestId, 'failure_scope');
    }
    if (!context.tenant.isRoot && scopeTeamId !== undefined && scopeTeamId !== teamIdValue) {
      throw invalidScope(context.requestId, 'failure_scope');
    }
    const teamId = new Types.ObjectId(teamIdValue);

    const cursor = parseCursor(input.cursor);
    if (input.cursor !== undefined && cursor === null) {
      throw invalidScope(context.requestId, 'cursor');
    }

    const take = input.limit + 1;
    const [deleteDocs, trainingDocs, migrationDocs, operationDocs, totals] = await Promise.all([
      this.deleteFailures
        .find({ teamId })
        .sort({ createTime: -1, _id: -1 })
        .limit(take)
        .lean<LeanDoc<DatasetDeleteFailureDoc>[]>(),
      this.trainings
        .find({ teamId })
        .sort({ createTime: -1, _id: -1 })
        .limit(take)
        .lean<LeanDoc<DatasetTrainingDoc>[]>(),
      this.migrationLogs
        .find({ teamId })
        .sort({ createTime: -1, _id: -1 })
        .limit(take)
        .lean<LeanDoc<DatasetMigrationLogDoc>[]>(),
      this.operationLogs
        .find({ teamId })
        .sort({ timestamp: -1, _id: -1 })
        .limit(take)
        .lean<LeanDoc<OperationLogDoc>[]>(),
      this.totalCounts(teamId),
    ]);

    const candidates: Candidate[] = [
      ...deleteDocs.map((doc) => ({
        timeMs: doc.createTime.getTime(),
        sourceRank: 0,
        idHex: String(doc._id),
        errorClass: doc.errorClass,
        record: {
          resourceType: doc.resourceType,
          resourceId: doc.resourceId,
          reason: doc.lastError,
          retryable: doc.retryable,
        },
      })),
      ...trainingDocs.map((doc) => ({
        timeMs: doc.createTime.getTime(),
        sourceRank: 1,
        idHex: String(doc._id),
        errorClass: doc.mode,
        record: {
          resourceType: 'training',
          resourceId: String(doc.dataId ?? doc.collectionId),
          reason: doc.errorMsg ?? 'training_failed',
          retryable: doc.retryCount > 0,
        },
      })),
      ...migrationDocs.map((doc) => ({
        timeMs: doc.createTime.getTime(),
        sourceRank: 2,
        idHex: String(doc._id),
        errorClass: doc.state,
        record: {
          resourceType: 'migration',
          resourceId: doc.resourceRef.resourceId,
          reason: doc.error?.['message'] !== undefined ? String(doc.error['message']) : doc.state,
          retryable: doc.state === 'failed',
        },
      })),
      ...operationDocs.map((doc) => ({
        timeMs: doc.timestamp.getTime(),
        sourceRank: 3,
        idHex: String(doc._id),
        errorClass: doc.result ?? 'audit',
        record: {
          resourceType: doc.resourceType ?? 'audit',
          resourceId: doc.resourceId ?? String(doc._id),
          reason: doc.event,
          retryable: false,
        },
      })),
    ];

    const resourceType =
      typeof scope['resourceType'] === 'string' ? scope['resourceType'] : undefined;
    const resourceId = typeof scope['resourceId'] === 'string' ? scope['resourceId'] : undefined;
    const errorClass = typeof scope['errorClass'] === 'string' ? scope['errorClass'] : undefined;
    const fromMs = toMs(scope['from']);
    const toMsBound = toMs(scope['to']);
    const cursorRef = cursor === null ? null : asCursor(cursor);

    const ordered = candidates
      .filter((candidate) => cursorRef === null || compareCandidate(candidate, cursorRef) > 0)
      .filter((candidate) => {
        if (resourceType !== undefined && candidate.record.resourceType !== resourceType) {
          return false;
        }
        if (resourceId !== undefined && candidate.record.resourceId !== resourceId) return false;
        if (errorClass !== undefined && candidate.errorClass !== errorClass) return false;
        if (fromMs !== undefined && candidate.timeMs < fromMs) return false;
        if (toMsBound !== undefined && candidate.timeMs > toMsBound) return false;
        return true;
      })
      .sort(compareCandidate);

    const page = ordered.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      total: totals,
      list: page.map((candidate) => candidate.record),
      cursor: ordered.length > input.limit && last !== undefined ? cursorKey(last) : null,
    };
  }

  private async totalCounts(teamId: Types.ObjectId): Promise<number> {
    const [a, b, c, d] = await Promise.all([
      this.deleteFailures.countDocuments({ teamId }),
      this.trainings.countDocuments({ teamId }),
      this.migrationLogs.countDocuments({ teamId }),
      this.operationLogs.countDocuments({ teamId }),
    ]);
    return a + b + c + d;
  }
}

export function createFailureQueryAdapter(deps: FailureQueryAdapterDeps): FailureQueryAdapter {
  return new FailureQueryAdapter(deps);
}
