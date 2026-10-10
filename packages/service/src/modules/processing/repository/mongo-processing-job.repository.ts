import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Connection, type Model } from 'mongoose';
import type { ProcessingJobRepository } from '../../../ports/repositories';
import type { ProcessingJobSnapshot, RequestContext } from '../../../ports/types';
import {
  DatasetTrainingSchema,
  type DatasetTrainingDoc,
} from '../../../shared/persistence/schemas';
import {
  blockedErrorMsg,
  PROCESSING_EPOCH_LOCK_TIME,
  PROCESSING_LEASE_MS,
  PROCESSING_PERMANENT_LOCK_TIME,
  initialRetryCount,
  manualRecoveryRetryCount,
  retryLockTime,
} from '../domain/lease';

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

function invalidState(
  taskId: string,
  from: string,
  to: string,
  requestId: string,
): ApiErrorException {
  return new ApiErrorException(
    createApiError({ code: 501005, requestId, params: { taskId, from, to } }),
  );
}

function retryExhausted(taskId: string, retryCount: number, requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({ code: 501006, requestId, params: { taskId, retryCount } }),
  );
}

type ProcessingFinishState = 'success' | 'failed' | 'blocked' | 'final_error';

interface FinishInput {
  taskId: string;
  state: ProcessingFinishState;
  errorMsg?: string;
  options: { timeoutMs: number };
}

interface FinishInputWithLease extends FinishInput {
  lockTime: string;
}

export class MongoProcessingJobRepository implements ProcessingJobRepository {
  private readonly model: Model<DatasetTrainingDoc>;

  constructor(connection: Connection) {
    this.model =
      (connection.models.DatasetTraining as Model<DatasetTrainingDoc>) ??
      connection.model<DatasetTrainingDoc>('DatasetTraining', DatasetTrainingSchema);
  }

  private teamId(context: RequestContext): Types.ObjectId {
    return toOid(context.tenant.teamId, 'teamId', context.requestId);
  }

  async enqueue(
    input: {
      job: Omit<ProcessingJobSnapshot, 'taskId' | 'retryCount' | 'lockTime'>;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ taskId: string; jobId: string }> {
    if (!input.job.jobId) {
      throw new ApiErrorException(
        createApiError({
          code: 501005,
          requestId: context.requestId,
          params: { taskId: '', from: 'new', to: 'missing_job_id' },
        }),
      );
    }
    const teamId = this.teamId(context);
    if (input.job.teamId !== context.tenant.teamId) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'processing_job', resourceId: input.job.jobId },
        }),
      );
    }
    const now = new Date();
    const expireAt = input.job.expireAt
      ? new Date(input.job.expireAt)
      : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const collectionId = input.job.collectionId
      ? toOid(input.job.collectionId, 'collectionId', context.requestId)
      : toOid(input.job.datasetId, 'datasetId', context.requestId);
    const doc = await this.model.create({
      teamId,
      datasetId: toOid(input.job.datasetId, 'datasetId', context.requestId),
      collectionId,
      dataId: input.job.dataId ?? null,
      mode: input.job.mode,
      retryCount: initialRetryCount(),
      lockTime: PROCESSING_EPOCH_LOCK_TIME,
      errorMsg: input.job.errorMsg ?? null,
      weight: input.job.weight ?? 0,
      expireAt: Number.isNaN(expireAt.getTime())
        ? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
        : expireAt,
      billId: null,
      payload: { __jobId: input.job.jobId },
      imageDescMap: null,
      indexes: [],
      createTime: now,
      updateTime: now,
    } as unknown as DatasetTrainingDoc);
    return { taskId: String(doc._id), jobId: input.job.jobId };
  }

  async claim(
    input: { taskId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ taskId: string; lockTime: string }> {
    const taskId = toOid(input.taskId, 'taskId', context.requestId);
    const now = new Date();
    const leaseCutoff = new Date(now.getTime() - PROCESSING_LEASE_MS);
    const claimed = await this.model
      .findOneAndUpdate(
        {
          _id: taskId,
          teamId: this.teamId(context),
          retryCount: { $gt: 0 },
          lockTime: { $lt: PROCESSING_PERMANENT_LOCK_TIME },
          $or: [{ lockTime: PROCESSING_EPOCH_LOCK_TIME }, { lockTime: { $lte: leaseCutoff } }],
        },
        { $inc: { retryCount: -1 }, $set: { lockTime: now, updateTime: now } },
        { new: true },
      )
      .lean();
    if (!claimed) {
      const current = await this.model
        .findOne({ _id: taskId, teamId: this.teamId(context) })
        .lean();
      if (!current) {
        throw new ApiErrorException(
          createApiError({
            code: 501070,
            requestId: context.requestId,
            params: { resourceType: 'task', resourceId: input.taskId },
          }),
        );
      }
      if (current.retryCount <= 0) {
        throw retryExhausted(input.taskId, current.retryCount, context.requestId);
      }
      throw invalidState(
        input.taskId,
        current.lockTime.toISOString(),
        now.toISOString(),
        context.requestId,
      );
    }
    return { taskId: String(claimed._id), lockTime: claimed.lockTime.toISOString() };
  }

  async renew(
    input: { taskId: string; lockTime: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ lockTime: string }> {
    const taskId = toOid(input.taskId, 'taskId', context.requestId);
    const oldLockTime = new Date(input.lockTime);
    const now = new Date();
    if (
      Number.isNaN(oldLockTime.getTime()) ||
      now.getTime() - oldLockTime.getTime() > PROCESSING_LEASE_MS
    ) {
      throw invalidState(input.taskId, input.lockTime, now.toISOString(), context.requestId);
    }
    const renewed = await this.model
      .findOneAndUpdate(
        {
          _id: taskId,
          teamId: this.teamId(context),
          lockTime: oldLockTime,
          retryCount: { $gt: 0 },
        },
        { $set: { lockTime: now, updateTime: now } },
        { new: true },
      )
      .lean();
    if (!renewed) {
      const current = await this.model
        .findOne({ _id: taskId, teamId: this.teamId(context) })
        .lean();
      if (!current) {
        throw new ApiErrorException(
          createApiError({
            code: 501070,
            requestId: context.requestId,
            params: { resourceType: 'task', resourceId: input.taskId },
          }),
        );
      }
      if (current.retryCount <= 0) {
        throw retryExhausted(input.taskId, current.retryCount, context.requestId);
      }
      throw invalidState(input.taskId, input.lockTime, now.toISOString(), context.requestId);
    }
    return { lockTime: renewed.lockTime.toISOString() };
  }

  async finish(input: FinishInput, context: RequestContext): Promise<void> {
    return this.finishTask(input, context);
  }

  async finishWithLease(input: FinishInputWithLease, context: RequestContext): Promise<void> {
    return this.finishTask(input, context, input.lockTime);
  }

  async resumeTask(
    input: { taskId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ taskId: string; retryCount: number }> {
    const taskId = toOid(input.taskId, 'taskId', context.requestId);
    const teamId = this.teamId(context);
    const now = new Date();
    const resumed = await this.model
      .findOneAndUpdate(
        {
          _id: taskId,
          teamId,
          lockTime: { $gte: PROCESSING_PERMANENT_LOCK_TIME },
        },
        {
          $set: {
            retryCount: manualRecoveryRetryCount(),
            lockTime: PROCESSING_EPOCH_LOCK_TIME,
            errorMsg: null,
            updateTime: now,
          },
        },
        { new: true },
      )
      .lean();
    if (!resumed) {
      const current = await this.model.findOne({ _id: taskId, teamId }).lean();
      if (!current) {
        throw new ApiErrorException(
          createApiError({
            code: 501070,
            requestId: context.requestId,
            params: { resourceType: 'task', resourceId: input.taskId },
          }),
        );
      }
      throw retryExhausted(input.taskId, current.retryCount, context.requestId);
    }
    return { taskId: String(resumed._id), retryCount: resumed.retryCount };
  }

  private parseLeaseToken(taskId: string, lockTime: string, requestId: string): Date {
    const parsed = new Date(lockTime);
    if (Number.isNaN(parsed.getTime())) {
      throw invalidState(taskId, lockTime, 'invalid_lock_time', requestId);
    }
    return parsed;
  }

  private async missingOrInvalidFinish(
    taskId: Types.ObjectId,
    resourceId: string,
    teamId: Types.ObjectId,
    requestId: string,
    from: string,
    to: string,
  ): Promise<never> {
    const exists = await this.model.exists({ _id: taskId, teamId });
    if (!exists) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId,
          params: { resourceType: 'task', resourceId },
        }),
      );
    }
    throw invalidState(resourceId, from, to, requestId);
  }

  private async finishTask(
    input: FinishInput,
    context: RequestContext,
    lockTime?: string,
  ): Promise<void> {
    const taskId = toOid(input.taskId, 'taskId', context.requestId);
    const teamId = this.teamId(context);
    const leaseFilter =
      lockTime === undefined
        ? {}
        : { lockTime: this.parseLeaseToken(input.taskId, lockTime, context.requestId) };
    if (input.state === 'success') {
      const result = await this.model.deleteOne({ _id: taskId, teamId, ...leaseFilter });
      if (result.deletedCount === 0) {
        return this.missingOrInvalidFinish(
          taskId,
          input.taskId,
          teamId,
          context.requestId,
          'running',
          'success',
        );
      }
      return;
    }
    const now = new Date();
    const current = await this.model.findOne({ _id: taskId, teamId, ...leaseFilter }).lean();
    if (!current) {
      return this.missingOrInvalidFinish(
        taskId,
        input.taskId,
        teamId,
        context.requestId,
        'running',
        input.state,
      );
    }
    const permanentlyLocked = input.state === 'blocked' || input.state === 'final_error';
    const nextLockTime =
      permanentlyLocked || current.retryCount <= 0
        ? PROCESSING_PERMANENT_LOCK_TIME
        : retryLockTime(current.mode, now);
    const errorMsg =
      input.state === 'blocked' ? blockedErrorMsg(input.errorMsg) : (input.errorMsg ?? input.state);
    const updated = await this.model.findOneAndUpdate(
      { _id: taskId, teamId, ...leaseFilter },
      {
        $set: {
          errorMsg,
          lockTime: nextLockTime,
          updateTime: now,
        },
      },
      { new: true },
    );
    if (!updated) {
      return this.missingOrInvalidFinish(
        taskId,
        input.taskId,
        teamId,
        context.requestId,
        lockTime ?? 'unknown',
        input.state,
      );
    }
  }
}
