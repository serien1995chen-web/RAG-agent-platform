import { ApiErrorException } from '@kb/contracts';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestContext } from '../../src/ports/types';
import { ProcessingApplicationService } from '../../src/modules/processing/application';
import {
  PROCESSING_EPOCH_LOCK_TIME,
  PROCESSING_LEASE_MS,
  PROCESSING_PERMANENT_LOCK_TIME,
  PROCESSING_QA_RETRY_WAIT_MS,
  PROCESSING_VECTOR_RETRY_WAIT_MS,
  canClaim,
  deriveProcessingState,
  retryLockTime,
  retryBudget,
} from '../../src/modules/processing/domain/lease';
import { MongoProcessingJobRepository } from '../../src/modules/processing/repository/mongo-processing-job.repository';
import {
  DatasetTrainingSchema,
  type DatasetTrainingDoc,
} from '../../src/shared/persistence/schemas';

const teamId = new mongoose.Types.ObjectId();

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let repository: MongoProcessingJobRepository;
let service: ProcessingApplicationService;
let model: mongoose.Model<DatasetTrainingDoc>;

function requestContext(requestId: string): RequestContext {
  return {
    requestId,
    tenant: {
      teamId: String(teamId),
      tmbId: String(new mongoose.Types.ObjectId()),
      authType: 'token',
      isRoot: false,
    },
    permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
  };
}

async function enqueue(jobId: string, mode: 'parse' | 'chunk' | 'qa' | 'vector'): Promise<string> {
  const result = await service.enqueueJob(
    {
      job: {
        jobId,
        teamId: String(teamId),
        datasetId: String(new mongoose.Types.ObjectId()),
        collectionId: String(new mongoose.Types.ObjectId()),
        mode,
        expireAt: new Date(Date.now() + 86_400_000).toISOString(),
        weight: 1,
      },
      options: { timeoutMs: 5_000 },
    },
    requestContext(`enqueue-${jobId}`),
  );
  return result.taskId;
}

async function expectApiError(promise: Promise<unknown>, code: number): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ApiErrorException(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiErrorException);
    if (error instanceof ApiErrorException) {
      expect(error.error.code).toBe(code);
    }
  }
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongo.getUri('kb_task_retry_lease'));
  await connection.asPromise();
  model = connection.model<DatasetTrainingDoc>('DatasetTraining', DatasetTrainingSchema);
  await model.init();
  repository = new MongoProcessingJobRepository(connection);
  service = new ProcessingApplicationService({ repository });
}, 60_000);

beforeEach(async () => {
  await model.deleteMany({});
});

afterAll(async () => {
  await connection.close();
  await mongo.stop();
});

describe('task retry, lease and manual recovery (P3-05)', () => {
  it('rejects a stale lease finish and lets the new owner complete the task', async () => {
    const taskId = await enqueue('lease-stale', 'chunk');
    const firstContext = requestContext('lease-first');
    await service.claimJob({ taskId, options: { timeoutMs: 5_000 } }, firstContext);

    await model.updateOne(
      { _id: taskId },
      { $set: { lockTime: new Date(Date.now() - PROCESSING_LEASE_MS - 1) } },
    );
    const secondContext = requestContext('lease-second');
    await service.claimJob({ taskId, options: { timeoutMs: 5_000 } }, secondContext);

    await expectApiError(
      service.finishJob({ taskId, state: 'success', options: { timeoutMs: 5_000 } }, firstContext),
      501005,
    );
    expect(await model.findById(taskId)).not.toBeNull();

    await service.finishJob(
      { taskId, state: 'success', options: { timeoutMs: 5_000 } },
      secondContext,
    );
    expect(await model.findById(taskId)).toBeNull();
  });

  it('consumes the initial budget exactly and manual recovery restores three attempts', async () => {
    const taskId = await enqueue('budget-initial', 'chunk');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const context = requestContext(`budget-${attempt}`);
      await service.claimJob({ taskId, options: { timeoutMs: 5_000 } }, context);
      await service.finishJob(
        {
          taskId,
          state: 'failed',
          errorMsg: 'temporary',
          options: { timeoutMs: 5_000 },
        },
        context,
      );
    }

    const exhausted = await model.findById(taskId).lean();
    expect(exhausted?.retryCount).toBe(0);
    expect(exhausted?.lockTime.getTime()).toBe(PROCESSING_PERMANENT_LOCK_TIME.getTime());
    await expectApiError(
      service.claimJob({ taskId, options: { timeoutMs: 5_000 } }, requestContext('exhausted')),
      501006,
    );
    expect(retryBudget('rebuild')).toBe(50);

    await service.resumeJob({ taskId, options: { timeoutMs: 5_000 } }, requestContext('resume'));
    const resumed = await model.findById(taskId).lean();
    expect(resumed?.retryCount).toBe(3);
    expect(resumed?.lockTime.getTime()).toBe(PROCESSING_EPOCH_LOCK_TIME.getTime());
    expect(resumed?.errorMsg).toBeNull();

    await service.claimJob({ taskId, options: { timeoutMs: 5_000 } }, requestContext('resumed'));
    expect((await model.findById(taskId).lean())?.retryCount).toBe(2);
  });

  it('applies QA and Vector retry waits before the task becomes claimable again', async () => {
    const taskId = await enqueue('wait-qa', 'qa');
    const context = requestContext('wait-qa');
    await service.claimJob({ taskId, options: { timeoutMs: 5_000 } }, context);
    const beforeFinish = Date.now();
    await service.finishJob(
      {
        taskId,
        state: 'failed',
        errorMsg: 'provider unavailable',
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    const task = await model.findById(taskId).lean();
    expect(task).not.toBeNull();
    expect(task!.lockTime.getTime()).toBeGreaterThanOrEqual(
      beforeFinish + PROCESSING_QA_RETRY_WAIT_MS - 1_000,
    );
    expect(deriveProcessingState({ ...task!, now: new Date(beforeFinish) })).toBe(
      'temporaryFailure',
    );

    const vectorNow = new Date();
    expect(retryLockTime('vector', vectorNow).getTime()).toBe(
      vectorNow.getTime() + PROCESSING_VECTOR_RETRY_WAIT_MS,
    );
  });

  it('does not auto-recover blocked tasks and only explicit recovery makes them claimable', async () => {
    const taskId = await enqueue('blocked-manual', 'chunk');
    const context = requestContext('blocked');
    await service.claimJob({ taskId, options: { timeoutMs: 5_000 } }, context);
    await service.finishJob(
      {
        taskId,
        state: 'blocked',
        errorMsg: 'quota',
        options: { timeoutMs: 5_000 },
      },
      context,
    );

    const blocked = await model.findById(taskId).lean();
    expect(blocked).not.toBeNull();
    expect(blocked!.lockTime.getTime()).toBe(PROCESSING_PERMANENT_LOCK_TIME.getTime());
    expect(canClaim(blocked!.lockTime, blocked!.retryCount, new Date('2049-12-31T23:59:59Z'))).toBe(
      false,
    );
    expect(deriveProcessingState(blocked!)).toBe('blocked');
    await expectApiError(
      service.claimJob({ taskId, options: { timeoutMs: 5_000 } }, requestContext('auto-recover')),
      501005,
    );

    await service.resumeJob({ taskId, options: { timeoutMs: 5_000 } }, requestContext('manual'));
    const recovered = await model.findById(taskId).lean();
    expect(recovered?.retryCount).toBe(3);
    expect(recovered?.lockTime.getTime()).toBe(PROCESSING_EPOCH_LOCK_TIME.getTime());
    await expect(
      service.claimJob({ taskId, options: { timeoutMs: 5_000 } }, requestContext('claim-after')),
    ).resolves.toMatchObject({ taskId });
  });
});
