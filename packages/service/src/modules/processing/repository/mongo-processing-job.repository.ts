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
  deriveProcessingState,
  isBlockedErrorMsg,
  isPermanentlyLocked,
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

interface ProcessingTaskErrorView {
  messageKey: string;
  retryable: 'retryable' | 'no-retry' | 'manual';
  category: 'provider' | 'storage' | 'task' | 'unknown';
}

interface ProcessingTaskView {
  taskId: string;
  jobId: string;
  datasetId: string;
  collectionId: string | null;
  dataId: string | null;
  mode: string;
  retryCount: number;
  lockTime: string;
  weight: number;
  derivedState: string;
  error: ProcessingTaskErrorView | null;
}

interface ProcessingTaskErrorPage {
  total: number;
  list: ProcessingTaskView[];
  cursor: string | null;
}

interface ProcessingQueueModeStats {
  mode: string;
  depth: number;
  running: number;
}

interface ErrorCursor {
  updateTime: string;
  taskId: string;
}

type PersistedTrainingTask = DatasetTrainingDoc & { _id: Types.ObjectId };

function taskJobId(doc: PersistedTrainingTask): string {
  const payload = doc.payload ?? {};
  const value = payload['__jobId'];
  return typeof value === 'string' && value.length > 0 ? value : String(doc._id);
}

function safeError(doc: DatasetTrainingDoc): ProcessingTaskErrorView | null {
  if (!doc.errorMsg) return null;
  if (isBlockedErrorMsg(doc.errorMsg)) {
    return { messageKey: 'dataset.task.blocked', retryable: 'manual', category: 'task' };
  }
  if (doc.retryCount <= 0 || isPermanentlyLocked(doc.lockTime)) {
    return { messageKey: 'dataset.task.final_failure', retryable: 'no-retry', category: 'task' };
  }
  const normalized = doc.errorMsg.toLowerCase();
  const category: ProcessingTaskErrorView['category'] =
    normalized.includes('provider') || normalized.includes('model')
      ? 'provider'
      : normalized.includes('mongo') || normalized.includes('redis') || normalized.includes('s3')
        ? 'storage'
        : normalized.includes('task')
          ? 'task'
          : 'unknown';
  return {
    messageKey:
      category === 'provider'
        ? 'dataset.task.provider_failure'
        : category === 'storage'
          ? 'dataset.task.storage_failure'
          : 'dataset.task.temporary_failure',
    retryable: 'retryable',
    category,
  };
}

function toTaskView(doc: PersistedTrainingTask): ProcessingTaskView {
  return {
    taskId: String(doc._id),
    jobId: taskJobId(doc),
    datasetId: String(doc.datasetId),
    collectionId: doc.collectionId ? String(doc.collectionId) : null,
    dataId: doc.dataId === null || doc.dataId === undefined ? null : String(doc.dataId),
    mode: doc.mode,
    retryCount: doc.retryCount,
    lockTime: doc.lockTime.toISOString(),
    weight: doc.weight,
    derivedState: deriveProcessingState(doc),
    error: safeError(doc),
  };
}

function encodeCursor(doc: PersistedTrainingTask): string {
  const cursor: ErrorCursor = {
    updateTime: doc.updateTime.toISOString(),
    taskId: String(doc._id),
  };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(
  value: string | undefined,
  requestId: string,
): { updateTime: Date; taskId: Types.ObjectId } | null {
  if (!value) return null;
  let parsed: ErrorCursor;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as ErrorCursor;
  } catch {
    throw invalidState('cursor', value, 'invalid_cursor', requestId);
  }
  const updateTime = new Date(parsed.updateTime);
  if (Number.isNaN(updateTime.getTime()) || !Types.ObjectId.isValid(parsed.taskId)) {
    throw invalidState('cursor', value, 'invalid_cursor', requestId);
  }
  return { updateTime, taskId: new Types.ObjectId(parsed.taskId) };
}

function scopeValue(value: string, field: string, requestId: string): Types.ObjectId | string {
  return Types.ObjectId.isValid(value) ? toOid(value, field, requestId) : value;
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

  async getTaskDetail(
    input: { taskId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ task: ProcessingTaskView; derivedState: string }> {
    const taskId = toOid(input.taskId, 'taskId', context.requestId);
    const task = await this.model.findOne({ _id: taskId, teamId: this.teamId(context) }).lean();
    if (!task) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'task', resourceId: input.taskId },
        }),
      );
    }
    const view = toTaskView(task as DatasetTrainingDoc & { _id: Types.ObjectId });
    return { task: view, derivedState: view.derivedState };
  }

  async listTaskErrors(
    input: {
      taskId?: string;
      collectionId?: string;
      datasetId?: string;
      cursor?: string;
      limit: number;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<ProcessingTaskErrorPage> {
    const filter: Record<string, unknown> = {
      teamId: this.teamId(context),
      errorMsg: { $ne: null },
    };
    if (input.taskId) filter._id = toOid(input.taskId, 'taskId', context.requestId);
    if (input.collectionId) {
      filter.collectionId = toOid(input.collectionId, 'collectionId', context.requestId);
    }
    if (input.datasetId) filter.datasetId = toOid(input.datasetId, 'datasetId', context.requestId);
    const cursor = decodeCursor(input.cursor, context.requestId);
    if (cursor) {
      filter.$or = [
        { updateTime: { $lt: cursor.updateTime } },
        { updateTime: cursor.updateTime, _id: { $lt: cursor.taskId } },
      ];
    }
    const limit = Math.min(Math.max(input.limit, 1), 50);
    const [docs, total] = await Promise.all([
      this.model.find(filter).sort({ updateTime: -1, _id: -1 }).limit(limit).lean(),
      this.model.countDocuments(filter),
    ]);
    const list = docs.map((doc) => toTaskView(doc as DatasetTrainingDoc & { _id: Types.ObjectId }));
    const last = docs.at(-1);
    return {
      total,
      list,
      cursor: last && docs.length === limit ? encodeCursor(last) : null,
    };
  }

  async getQueueStats(
    input: { datasetId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<ProcessingQueueModeStats[]> {
    const rows = await this.model.aggregate<{
      _id: string;
      depth: number;
      running: number;
    }>([
      {
        $match: {
          teamId: this.teamId(context),
          datasetId: toOid(input.datasetId, 'datasetId', context.requestId),
        },
      },
      {
        $group: {
          _id: '$mode',
          depth: { $sum: 1 },
          running: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gt: ['$lockTime', PROCESSING_EPOCH_LOCK_TIME] },
                    { $lt: ['$lockTime', PROCESSING_PERMANENT_LOCK_TIME] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    return rows.map((row) => ({ mode: row._id, depth: row.depth, running: row.running }));
  }

  async updateTrainingData(
    input: {
      dataId?: string;
      collectionId?: string;
      datasetId?: string;
      mode: string;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ acceptedCount: number }> {
    const scopeFilter: Record<string, unknown> = {};
    if (input.dataId) {
      scopeFilter.dataId = scopeValue(input.dataId, 'dataId', context.requestId);
    }
    if (input.collectionId) {
      scopeFilter.collectionId = toOid(input.collectionId, 'collectionId', context.requestId);
    }
    if (input.datasetId) {
      scopeFilter.datasetId = toOid(input.datasetId, 'datasetId', context.requestId);
    }
    const baseFilter = {
      teamId: this.teamId(context),
      mode: input.mode,
      ...scopeFilter,
    };
    const now = new Date();
    const result = await this.model.updateMany(
      {
        ...baseFilter,
        retryCount: { $gt: 0 },
        lockTime: { $lt: PROCESSING_PERMANENT_LOCK_TIME },
      },
      { $set: { lockTime: PROCESSING_EPOCH_LOCK_TIME, errorMsg: null, updateTime: now } },
    );
    if (result.modifiedCount === 0 && (await this.model.exists(baseFilter))) {
      throw retryExhausted('', 0, context.requestId);
    }
    return { acceptedCount: result.modifiedCount };
  }

  async deleteTrainingData(
    input: { collectionId?: string; dataId?: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ deletedCount: number }> {
    const filter: Record<string, unknown> = { teamId: this.teamId(context) };
    if (input.collectionId) {
      filter.collectionId = toOid(input.collectionId, 'collectionId', context.requestId);
    } else if (input.dataId) {
      filter.dataId = scopeValue(input.dataId, 'dataId', context.requestId);
    }
    const result = await this.model.deleteMany(filter);
    return { deletedCount: result.deletedCount };
  }

  async listCollectionErrors(
    input: { collectionId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<ProcessingTaskView[]> {
    const docs = await this.model
      .find({
        teamId: this.teamId(context),
        collectionId: toOid(input.collectionId, 'collectionId', context.requestId),
        errorMsg: { $ne: null },
      })
      .sort({ updateTime: -1, _id: -1 })
      .limit(50)
      .lean();
    return docs.map((doc) => toTaskView(doc as DatasetTrainingDoc & { _id: Types.ObjectId }));
  }

  async hasError(
    input: { datasetId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<boolean> {
    const finalErrors = await this.model.exists({
      teamId: this.teamId(context),
      datasetId: toOid(input.datasetId, 'datasetId', context.requestId),
      errorMsg: { $ne: null },
      $or: [{ retryCount: { $lte: 0 } }, { lockTime: { $gte: PROCESSING_PERMANENT_LOCK_TIME } }],
    });
    return finalErrors !== null;
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
