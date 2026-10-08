import { ApiErrorException } from '@kb/contracts';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PROCESSING_PERMANENT_LOCK_TIME,
  retryBudget,
} from '../../src/modules/processing/domain/lease';
import { MongoProcessingJobRepository } from '../../src/modules/processing/repository/mongo-processing-job.repository';
import {
  DatasetTrainingSchema,
  type DatasetTrainingDoc,
} from '../../src/shared/persistence/schemas';
import type { RequestContext } from '../../src/ports/types';

const teamId = new mongoose.Types.ObjectId();
const context: RequestContext = {
  requestId: 'req-processing-repo',
  tenant: {
    teamId: String(teamId),
    tmbId: String(new mongoose.Types.ObjectId()),
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let repository: MongoProcessingJobRepository;
let model: mongoose.Model<DatasetTrainingDoc>;

async function enqueue(jobId: string): Promise<string> {
  const result = await repository.enqueue(
    {
      job: {
        jobId,
        teamId: String(teamId),
        datasetId: String(new mongoose.Types.ObjectId()),
        collectionId: String(new mongoose.Types.ObjectId()),
        mode: 'chunk',
        expireAt: new Date(Date.now() + 86_400_000).toISOString(),
        weight: 1,
      },
      options: { timeoutMs: 5_000 },
    },
    context,
  );
  expect(result.jobId).toBe(jobId);
  return result.taskId;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongo.getUri('kb_processing_repository'));
  await connection.asPromise();
  model = connection.model<DatasetTrainingDoc>('DatasetTraining', DatasetTrainingSchema);
  await model.init();
  repository = new MongoProcessingJobRepository(connection);
}, 60_000);

beforeEach(async () => {
  await model.deleteMany({});
});

afterAll(async () => {
  await connection.close();
  await mongo.stop();
});

describe('MongoProcessingJobRepository (P2-11 / PORT-DATA-004)', () => {
  it('writes Mongo facts before returning and lets only one concurrent claim win', async () => {
    const taskId = await enqueue('job-1');
    const before = await model.findById(taskId).lean();
    expect(before?.payload).toMatchObject({ __jobId: 'job-1' });

    const attempts = await Promise.allSettled([
      repository.claim({ taskId, options: { timeoutMs: 5_000 } }, context),
      repository.claim({ taskId, options: { timeoutMs: 5_000 } }, context),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const after = await model.findById(taskId).lean();
    expect(after?.retryCount).toBe(4);
  });

  it('renews only the current lease and makes success delete the task', async () => {
    const taskId = await enqueue('job-2');
    const claimed = await repository.claim({ taskId, options: { timeoutMs: 5_000 } }, context);
    const renewed = await repository.renew(
      { taskId, lockTime: claimed.lockTime, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(new Date(renewed.lockTime).getTime()).toBeGreaterThanOrEqual(
      new Date(claimed.lockTime).getTime(),
    );
    await expect(
      repository.renew(
        { taskId, lockTime: claimed.lockTime, options: { timeoutMs: 5_000 } },
        context,
      ),
    ).rejects.toBeInstanceOf(ApiErrorException);
    await repository.finish({ taskId, state: 'success', options: { timeoutMs: 5_000 } }, context);
    expect(await model.findById(taskId)).toBeNull();
  });

  it('keeps failed tasks retryable and permanently locks final errors', async () => {
    const failedTask = await enqueue('job-failed');
    await repository.claim({ taskId: failedTask, options: { timeoutMs: 5_000 } }, context);
    await repository.finish(
      { taskId: failedTask, state: 'failed', errorMsg: 'temporary', options: { timeoutMs: 5_000 } },
      context,
    );
    expect((await model.findById(failedTask).lean())?.lockTime.getTime()).toBeLessThan(
      PROCESSING_PERMANENT_LOCK_TIME.getTime(),
    );

    const finalTask = await enqueue('job-final');
    await repository.finish(
      { taskId: finalTask, state: 'final_error', errorMsg: 'fatal', options: { timeoutMs: 5_000 } },
      context,
    );
    expect((await model.findById(finalTask).lean())?.lockTime.getTime()).toBe(
      PROCESSING_PERMANENT_LOCK_TIME.getTime(),
    );
    expect([retryBudget('initial'), retryBudget('rebuild'), retryBudget('manual')]).toEqual([
      5, 50, 3,
    ]);
  });
});
