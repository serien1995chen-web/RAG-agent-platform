import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Connection, type Model } from 'mongoose';
import type { DeleteJobRepository } from '../../../ports/repositories';
import type {
  DeleteJobSnapshot,
  DeleteJobState,
  PageResult,
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

  private async toSnapshot(doc: DatasetDeleteJobDoc): Promise<DeleteJobSnapshot> {
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
}
