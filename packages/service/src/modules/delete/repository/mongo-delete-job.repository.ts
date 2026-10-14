import { ApiErrorException, createApiError } from '@kb/contracts';
import { buildDeleteJobId } from '@kb/dal';
import { Types, type Connection, type Model } from 'mongoose';
import type { DeleteJobRepository } from '../../../ports/repositories';
import type {
  DeleteJobSnapshot,
  DeleteJobState,
  PageResult,
  PortCallOptions,
  RequestContext,
} from '../../../ports/types';
import {
  DatasetDeleteFailureSchema,
  DatasetDeleteJobSchema,
  type DatasetDeleteFailureDoc,
  type DatasetDeleteJobDoc,
} from '../../../shared/persistence/schemas';
import { canTransition } from '../domain/state';

function toOid(value: string, field: string, requestId: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) {
    throw new ApiErrorException(
      createApiError({
        code: 501070,
        requestId,
        params: { resourceType: field, resourceId: value },
      }),
    );
  }
  return new Types.ObjectId(value);
}

function invalidTransition(
  taskId: string,
  from: DeleteJobState,
  to: DeleteJobState,
  requestId: string,
) {
  throw new ApiErrorException(
    createApiError({ code: 501005, requestId, params: { taskId, from, to } }),
  );
}

/** 租约领取结果（最小字段集，供清理运行器判定阶段与重试预算）。 */
export interface DeleteJobLeaseClaim {
  jobId: string;
  datasetId: string;
  state: DeleteJobState;
  stage: string;
  attempt: number;
  leaseOwner: string;
}

export interface DeleteJobFailureInput {
  jobId: string;
  resourceType: string;
  resourceId: string;
  stage: string;
  attempt: number;
  errorClass: string;
  retryable: boolean;
  lastError: string;
}

export interface DeleteJobScopeSnapshot extends DeleteJobSnapshot {
  actorTmbId: string | null;
  ownerTmbId: string | null;
}

export class MongoDeleteJobRepository implements DeleteJobRepository {
  private readonly model: Model<DatasetDeleteJobDoc>;
  private readonly failures: Model<DatasetDeleteFailureDoc>;

  constructor(connection: Connection) {
    this.model =
      (connection.models.DatasetDeleteJob as Model<DatasetDeleteJobDoc>) ??
      connection.model<DatasetDeleteJobDoc>('DatasetDeleteJob', DatasetDeleteJobSchema);
    this.failures =
      (connection.models.DatasetDeleteFailure as Model<DatasetDeleteFailureDoc>) ??
      connection.model<DatasetDeleteFailureDoc>('DatasetDeleteFailure', DatasetDeleteFailureSchema);
  }

  private teamId(context: RequestContext): Types.ObjectId {
    return toOid(context.tenant.teamId, 'teamId', context.requestId);
  }

  private async toSnapshot(doc: DatasetDeleteJobDoc): Promise<DeleteJobScopeSnapshot> {
    const failureCount = await this.failures.countDocuments({
      teamId: doc.teamId,
      jobId: doc.jobId,
    });
    return {
      jobId: doc.jobId,
      teamId: String(doc.teamId),
      datasetId: String(doc.datasetId),
      state: doc.state as DeleteJobState,
      stage: doc.stage,
      progress:
        doc.progress.total === 0 ? 0 : Math.round((doc.progress.done / doc.progress.total) * 100),
      failureCount,
      actorTmbId: doc.actorTmbId ? String(doc.actorTmbId) : null,
      ownerTmbId: doc.ownerTmbId ? String(doc.ownerTmbId) : null,
      createTime: doc.createTime.toISOString(),
      updateTime: doc.updateTime.toISOString(),
    };
  }

  async create(
    input: {
      job: Omit<DeleteJobSnapshot, 'jobId' | 'createTime' | 'updateTime'>;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ jobId: string }> {
    const teamId = this.teamId(context);
    const datasetId = toOid(input.job.datasetId, 'datasetId', context.requestId);
    const jobId = `${String(teamId)}:${String(datasetId)}:delete`;
    const now = new Date();
    const doc = await this.model
      .findOneAndUpdate(
        { teamId, datasetId },
        {
          $setOnInsert: {
            jobId,
            teamId,
            datasetId,
            actorTmbId: toOid(context.tenant.tmbId, 'tmbId', context.requestId),
            ownerTmbId: null,
            state: 'marked',
            stage: 'mongo',
            progress: { total: 0, done: 0, failed: 0, skipped: 0 },
            attempt: 0,
            error: null,
            leaseOwner: null,
            leaseExpireAt: null,
            createTime: now,
            updateTime: now,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .lean();
    return { jobId: doc.jobId };
  }

  async get(
    input: { jobId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<DeleteJobSnapshot> {
    const doc = await this.model
      .findOne({ jobId: input.jobId, teamId: this.teamId(context) })
      .lean();
    if (!doc) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'delete_job', resourceId: input.jobId },
        }),
      );
    }
    return this.toSnapshot(doc as DatasetDeleteJobDoc);
  }

  async findByScope(
    input: {
      datasetId?: string;
      collectionId?: string;
      dataId?: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<DeleteJobScopeSnapshot | null> {
    const teamId = this.teamId(context);
    let jobId: string | RegExp;
    if (input.collectionId) {
      const datasetSegment = input.datasetId ? escapeRegExp(input.datasetId) : '[0-9a-fA-F]{24}';
      jobId = new RegExp(
        `^${escapeRegExp(String(teamId))}:${datasetSegment}:collection:${escapeRegExp(input.collectionId)}:delete$`,
      );
    } else if (input.dataId) {
      const datasetSegment = input.datasetId ? escapeRegExp(input.datasetId) : '[0-9a-fA-F]{24}';
      jobId = new RegExp(
        `^${escapeRegExp(String(teamId))}:${datasetSegment}:data:${escapeRegExp(input.dataId)}:delete$`,
      );
    } else if (input.datasetId) {
      jobId = buildDeleteJobId(String(teamId), input.datasetId);
    } else {
      return null;
    }

    const doc = await this.model.findOne({ teamId, jobId }).sort({ updateTime: -1 }).lean();
    return doc ? this.toSnapshot(doc as DatasetDeleteJobDoc) : null;
  }

  async transition(
    input: {
      jobId: string;
      expectedState: DeleteJobState;
      nextState: DeleteJobState;
      stage?: string;
      progress?: { total: number; done: number; failed: number; skipped: number };
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<DeleteJobSnapshot> {
    const current = await this.get(input, context);
    if (!canTransition(current.state, input.nextState)) {
      invalidTransition(input.jobId, current.state, input.nextState, context.requestId);
    }
    const now = new Date();
    const updated = await this.model
      .findOneAndUpdate(
        {
          teamId: this.teamId(context),
          jobId: input.jobId,
          state: input.expectedState,
        },
        {
          $set: {
            state: input.nextState,
            ...(input.stage !== undefined ? { stage: input.stage } : {}),
            ...(input.progress !== undefined ? { progress: input.progress } : {}),
            updateTime: now,
          },
        },
        { new: true },
      )
      .lean();
    if (!updated) {
      invalidTransition(input.jobId, input.expectedState, input.nextState, context.requestId);
    }
    return this.toSnapshot(updated as DatasetDeleteJobDoc);
  }

  async listFailures(
    input: { jobId: string; cursor?: string; limit: number; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<PageResult<{ resourceType: string; resourceId: string; reason: string }>> {
    const filter: Record<string, unknown> = {
      teamId: this.teamId(context),
      jobId: input.jobId,
    };
    if (input.cursor && Types.ObjectId.isValid(input.cursor)) {
      filter._id = { $gt: new Types.ObjectId(input.cursor) };
    }
    const docs = await this.failures
      .find(filter)
      .sort({ createTime: 1, _id: 1 })
      .limit(input.limit + 1)
      .lean();
    const page = docs.slice(0, input.limit);
    const cursor = docs.length > input.limit ? String(page[page.length - 1]?._id ?? '') : null;
    return {
      total: await this.failures.countDocuments(filter),
      list: page.map((doc) => ({
        resourceType: doc.resourceType,
        resourceId: doc.resourceId,
        reason: doc.lastError,
      })),
      cursor: cursor || null,
    };
  }

  async retry(
    input: { jobId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ accepted: boolean }> {
    const updated = await this.model.findOneAndUpdate(
      { teamId: this.teamId(context), jobId: input.jobId, state: 'failed' },
      { $set: { state: 'queued', updateTime: new Date() }, $inc: { attempt: 1 } },
    );
    return { accepted: Boolean(updated) };
  }

  /**
   * E1 租约领取：queued→deleting；deleting 且租约过期时原子接管。
   * 两条路径都以 teamId+jobId 过滤，任一路径失败返回 null（不可领取）。
   */
  async claimWithLease(
    input: { jobId: string; leaseOwner: string; leaseMs: number; now: Date },
    context: RequestContext,
  ): Promise<DeleteJobLeaseClaim | null> {
    const teamId = this.teamId(context);
    const leaseExpireAt = new Date(input.now.getTime() + input.leaseMs);
    const leaseSet = {
      leaseOwner: input.leaseOwner,
      leaseExpireAt,
      updateTime: input.now,
    };
    let doc = await this.model
      .findOneAndUpdate(
        { teamId, jobId: input.jobId, state: 'queued' },
        { $set: { ...leaseSet, state: 'deleting' } },
        { new: true },
      )
      .lean();
    if (!doc) {
      doc = await this.model
        .findOneAndUpdate(
          {
            teamId,
            jobId: input.jobId,
            state: 'deleting',
            leaseExpireAt: { $lte: input.now },
          },
          { $set: leaseSet },
          { new: true },
        )
        .lean();
    }
    if (!doc) return null;
    return {
      jobId: doc.jobId,
      datasetId: String(doc.datasetId),
      state: doc.state as DeleteJobState,
      stage: doc.stage,
      attempt: doc.attempt,
      leaseOwner: input.leaseOwner,
    };
  }

  /** 续租：仅 leaseOwner 匹配且 state=deleting 时成功。 */
  async renewLease(
    input: { jobId: string; leaseOwner: string; leaseMs: number; now: Date },
    context: RequestContext,
  ): Promise<boolean> {
    const updated = await this.model.findOneAndUpdate(
      {
        teamId: this.teamId(context),
        jobId: input.jobId,
        state: 'deleting',
        leaseOwner: input.leaseOwner,
      },
      {
        $set: {
          leaseExpireAt: new Date(input.now.getTime() + input.leaseMs),
          updateTime: input.now,
        },
      },
    );
    return Boolean(updated);
  }

  /**
   * 释放租约：置 leaseOwner=null、leaseExpireAt=纪元时间，
   * 使「deleting 且租约过期」的接管条件可立即命中。
   */
  async releaseLease(
    input: { jobId: string; leaseOwner: string; now: Date },
    context: RequestContext,
  ): Promise<void> {
    await this.model.findOneAndUpdate(
      {
        teamId: this.teamId(context),
        jobId: input.jobId,
        state: 'deleting',
        leaseOwner: input.leaseOwner,
      },
      { $set: { leaseOwner: null, leaseExpireAt: new Date(0), updateTime: input.now } },
    );
  }

  /** 进度/阶段写入：仅 leaseOwner 匹配可写（原子条件更新）。 */
  async updateProgressGuarded(
    input: {
      jobId: string;
      leaseOwner: string;
      stage?: string;
      progress?: { total: number; done: number; failed: number; skipped: number };
      now?: Date;
    },
    context: RequestContext,
  ): Promise<boolean> {
    const updated = await this.model.findOneAndUpdate(
      {
        teamId: this.teamId(context),
        jobId: input.jobId,
        state: 'deleting',
        leaseOwner: input.leaseOwner,
      },
      {
        $set: {
          ...(input.stage !== undefined ? { stage: input.stage } : {}),
          ...(input.progress !== undefined ? { progress: input.progress } : {}),
          updateTime: input.now ?? new Date(),
        },
      },
    );
    return Boolean(updated);
  }

  /** 失败事实源：每次失败一条（teamId 强制）。 */
  async recordFailure(input: DeleteJobFailureInput, context: RequestContext): Promise<void> {
    const now = new Date();
    await this.failures.create({
      teamId: this.teamId(context),
      jobId: input.jobId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      stage: input.stage,
      attempt: input.attempt,
      errorClass: input.errorClass,
      retryable: input.retryable,
      lastError: input.lastError,
      createTime: now,
      updateTime: now,
    });
  }

  /** 重试复位：failed→queued 且 attempt+1（仅稳定 jobId 命中时成功）。 */
  async resetRetry(input: { jobId: string }, context: RequestContext): Promise<boolean> {
    const updated = await this.model.findOneAndUpdate(
      { teamId: this.teamId(context), jobId: input.jobId, state: 'failed' },
      { $set: { state: 'queued', updateTime: new Date() }, $inc: { attempt: 1 } },
    );
    return Boolean(updated);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
