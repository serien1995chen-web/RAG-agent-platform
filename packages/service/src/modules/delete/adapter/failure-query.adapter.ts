import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Connection, type Model } from 'mongoose';
import type {
  FailureQueryPort,
  FailureRecord as FailureQueryRecord,
} from '../../../ports/capabilities';
import type { PageResult, PortCallOptions, RequestContext } from '../../../ports/types';
import {
  DatasetDeleteFailureSchema,
  type DatasetDeleteFailureDoc,
} from '../../../shared/persistence/schemas';

type FailureDocLean = DatasetDeleteFailureDoc & { _id: Types.ObjectId };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidScope(requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501070,
      requestId,
      params: { resourceType: 'failure_scope', resourceId: '' },
    }),
  );
}

interface FailureCursor {
  createTime: Date;
  id: Types.ObjectId;
}

function parseCursor(cursor: string | undefined): FailureCursor | null {
  if (cursor === undefined) return null;
  const match = /^(\d+):([0-9a-fA-F]{24})$/.exec(cursor);
  if (!match) return null;
  const [, timeText, idText] = match;
  if (timeText === undefined || idText === undefined) return null;
  return { createTime: new Date(Number(timeText)), id: new Types.ObjectId(idText) };
}

/**
 * FailureQueryPort 适配器（E2）：按 scope（jobId/teamId）分页查询 dataset_delete_failures；
 * 只读，不写回；查询强制 teamId（Root 需显式 scope.teamId）。
 * 分页稳定规则：createTime+_id 升序，cursor 为上一页末条 _id。
 */
export class FailureQueryAdapter implements FailureQueryPort {
  private readonly model: Model<DatasetDeleteFailureDoc>;

  constructor(connection: Connection) {
    this.model =
      (connection.models.DatasetDeleteFailure as Model<DatasetDeleteFailureDoc>) ??
      connection.model<DatasetDeleteFailureDoc>('DatasetDeleteFailure', DatasetDeleteFailureSchema);
  }

  async query(
    input: { scope: unknown; cursor?: string; limit: number; options: PortCallOptions },
    context: RequestContext,
  ): Promise<PageResult<FailureQueryRecord>> {
    const scope = isRecord(input.scope) ? input.scope : {};
    const scopeTeamId = typeof scope['teamId'] === 'string' ? scope['teamId'] : undefined;
    const teamIdValue = context.tenant.isRoot ? scopeTeamId : context.tenant.teamId;
    if (teamIdValue === undefined || !Types.ObjectId.isValid(teamIdValue)) {
      throw invalidScope(context.requestId);
    }
    const filter: Record<string, unknown> = { teamId: new Types.ObjectId(teamIdValue) };
    if (typeof scope['jobId'] === 'string' && scope['jobId'] !== '') {
      filter.jobId = scope['jobId'];
    }
    const cursor = parseCursor(input.cursor);
    if (cursor) {
      filter.$or = [
        { createTime: { $gt: cursor.createTime } },
        { createTime: cursor.createTime, _id: { $gt: cursor.id } },
      ];
    }
    const docs = (await this.model
      .find(filter)
      .sort({ createTime: 1, _id: 1 })
      .limit(input.limit + 1)
      .lean()) as unknown as FailureDocLean[];
    const page = docs.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      total: await this.model.countDocuments(filter),
      list: page.map((doc) => ({
        resourceType: doc.resourceType,
        resourceId: doc.resourceId,
        reason: doc.lastError,
        retryable: doc.retryable,
      })),
      cursor:
        docs.length > input.limit && last !== undefined
          ? `${last.createTime.getTime()}:${String(last._id)}`
          : null,
    };
  }
}
