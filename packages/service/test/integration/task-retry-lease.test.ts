import { ApiErrorException } from '@kb/contracts';
import { buildChunkJobId, buildParseJobId, type QueueName, type QueuePort } from '@kb/dal';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatasetSyncApplicationService } from '../../src/modules/collection/application/sync.service';
import { ProcessingApplicationService } from '../../src/modules/processing/application';
import {
  PROCESSING_EPOCH_LOCK_TIME,
  PROCESSING_LEASE_MS,
  PROCESSING_PERMANENT_LOCK_TIME,
  PROCESSING_QA_RETRY_WAIT_MS,
  PROCESSING_RETRY_NOT_BEFORE_KEY,
  PROCESSING_VECTOR_RETRY_WAIT_MS,
  canClaim,
  deriveProcessingState,
  retryBackoffUntil,
} from '../../src/modules/processing/domain/lease';
import { MongoProcessingJobRepository } from '../../src/modules/processing/repository/mongo-processing-job.repository';
import {
  DatasetTrainingSchema,
  type DatasetTrainingDoc,
} from '../../src/shared/persistence/schemas';
import type { CollectionSnapshot, RequestContext } from '../../src/ports/types';

const dbName = 'kb_task_retry_lease';
const teamA = new mongoose.Types.ObjectId();
const teamB = new mongoose.Types.ObjectId();
const datasetId = new mongoose.Types.ObjectId();
const collectionId = new mongoose.Types.ObjectId();

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let repository: MongoProcessingJobRepository;
let service: ProcessingApplicationService;
let model: mongoose.Model<DatasetTrainingDoc>;

function requestContext(teamId: mongoose.Types.ObjectId, requestId: string): RequestContext {
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

async function createConnection(): Promise<{
  connection: mongoose.Connection;
  model: mongoose.Model<DatasetTrainingDoc>;
  repository: MongoProcessingJobRepository;
  service: ProcessingApplicationService;
}> {
  const created = mongoose.createConnection(mongo.getUri(dbName));
  await created.asPromise();
  const createdModel = created.model<DatasetTrainingDoc>('DatasetTraining', DatasetTrainingSchema);
  await createdModel.init();
  const createdRepository = new MongoProcessingJobRepository(created);
  return {
    connection: created,
    model: createdModel,
    repository: createdRepository,
    service: new ProcessingApplicationService({ repository: createdRepository }),
  };
}

async function enqueue(input: {
  jobId: string;
  mode?: 'parse' | 'chunk' | 'qa';
  teamId?: mongoose.Types.ObjectId;
  budgetKind?: 'initial' | 'rebuild' | 'manual';
}): Promise<{ taskId: string; datasetId: string; collectionId: string }> {
  const result = await service.enqueueJob(
    {
      job: {
        jobId: input.jobId,
        teamId: String(input.teamId ?? teamA),
        datasetId: String(datasetId),
        collectionId: String(collectionId),
        mode: input.mode ?? 'chunk',
        expireAt: new Date(Date.now() + 86_400_000).toISOString(),
        weight: 1,
      },
      ...(input.budgetKind !== undefined ? { budgetKind: input.budgetKind } : {}),
      options: { timeoutMs: 5_000 },
    },
    requestContext(input.teamId ?? teamA, `enqueue-${input.jobId}`),
  );
  return {
    taskId: result.taskId,
    datasetId: String(datasetId),
    collectionId: String(collectionId),
  };
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

class FakeQueue implements QueuePort {
  readonly calls: Array<{ queue: QueueName; jobId: string }> = [];

  async enqueue(queue: QueueName, jobId: string): Promise<{ jobId: string; enqueued: boolean }> {
    this.calls.push({ queue, jobId });
    return { jobId, enqueued: true };
  }

  async remove(): Promise<void> {}
  async close(): Promise<void> {}
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const created = await createConnection();
  connection = created.connection;
  model = created.model;
  repository = created.repository;
  service = created.service;
}, 60_000);

beforeEach(async () => {
  await model.deleteMany({});
});

afterAll(async () => {
  await connection.close();
  await mongo.stop();
});

describe('task retry, lease and durable recovery (P3-05/P3-09)', () => {
  it('rejects a stale lease finish and lets the new owner complete the task', async () => {
    const { taskId } = await enqueue({ jobId: 'lease-stale' });
    const firstContext = requestContext(teamA, 'lease-first');
    await service.claimJob({ taskId, options: { timeoutMs: 5_000 } }, firstContext);

    await model.updateOne(
      { _id: taskId },
      { $set: { lockTime: new Date(Date.now() - PROCESSING_LEASE_MS - 1) } },
    );
    const secondContext = requestContext(teamA, 'lease-second');
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

  it('creates rebuild tasks with 50 attempts and exhausts all of them', async () => {
    const { taskId } = await enqueue({
      jobId: 'budget-rebuild',
      budgetKind: 'rebuild',
    });
    expect((await model.findById(taskId).lean())?.retryCount).toBe(50);

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const context = requestContext(teamA, `rebuild-${attempt}`);
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
      service.claimJob({ taskId, options: { timeoutMs: 5_000 } }, requestContext(teamA, 'done')),
      501006,
    );
  });

  it('uses payload backoff for exact QA and Vector retry waits', async () => {
    const qaStart = new Date();
    const qaBackoff = retryBackoffUntil('qa', qaStart);
    const vectorBackoff = retryBackoffUntil('vector', qaStart);
    expect(qaBackoff?.getTime()).toBe(qaStart.getTime() + PROCESSING_QA_RETRY_WAIT_MS);
    expect(vectorBackoff?.getTime()).toBe(qaStart.getTime() + PROCESSING_VECTOR_RETRY_WAIT_MS);

    const { taskId } = await enqueue({ jobId: 'wait-qa', mode: 'qa' });
    const context = requestContext(teamA, 'wait-qa');
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
    expect(task?.lockTime.getTime()).toBe(PROCESSING_EPOCH_LOCK_TIME.getTime());
    const notBefore = new Date(
      task?.payload[PROCESSING_RETRY_NOT_BEFORE_KEY] as string | number | Date,
    );
    expect(notBefore.getTime()).toBeGreaterThanOrEqual(
      beforeFinish + PROCESSING_QA_RETRY_WAIT_MS - 1_000,
    );
    expect(deriveProcessingState({ ...task!, now: new Date(beforeFinish) })).toBe(
      'temporaryFailure',
    );
    expect(deriveProcessingState({ ...task!, now: new Date(notBefore.getTime() + 1) })).toBe(
      'active',
    );
    expect(canClaim(task!.lockTime, task!.retryCount, new Date(beforeFinish), task!.payload)).toBe(
      false,
    );
    expect(
      canClaim(task!.lockTime, task!.retryCount, new Date(notBefore.getTime() + 1), task!.payload),
    ).toBe(true);
    await expectApiError(
      service.claimJob({ taskId, options: { timeoutMs: 5_000 } }, requestContext(teamA, 'early')),
      501005,
    );

    await model.updateOne(
      { _id: taskId },
      { $set: { [`payload.${PROCESSING_RETRY_NOT_BEFORE_KEY}`]: new Date(Date.now() - 1) } },
    );
    await expect(
      service.claimJob({ taskId, options: { timeoutMs: 5_000 } }, requestContext(teamA, 'due')),
    ).resolves.toMatchObject({ taskId });
  });

  it('does not reset an active lease from updateTrainingData', async () => {
    const { taskId } = await enqueue({ jobId: 'update-active', mode: 'qa' });
    const context = requestContext(teamA, 'update-active');
    await service.claimJob({ taskId, options: { timeoutMs: 5_000 } }, context);
    const before = await model.findById(taskId).lean();

    await expect(
      service.updateTrainingData(
        { datasetId: String(datasetId), mode: 'qa', options: { timeoutMs: 5_000 } },
        context,
      ),
    ).resolves.toEqual({ acceptedCount: 0 });
    const after = await model.findById(taskId).lean();
    expect(after?.retryCount).toBe(before?.retryCount);
    expect(after?.lockTime.getTime()).toBe(before?.lockTime.getTime());
    expect(after?.errorMsg).toBe(before?.errorMsg);

    await service.finishJob(
      { taskId, state: 'failed', errorMsg: 'provider', options: { timeoutMs: 5_000 } },
      context,
    );
    await expect(
      service.updateTrainingData(
        { datasetId: String(datasetId), mode: 'qa', options: { timeoutMs: 5_000 } },
        context,
      ),
    ).resolves.toEqual({ acceptedCount: 0 });

    await model.updateOne(
      { _id: taskId },
      { $set: { [`payload.${PROCESSING_RETRY_NOT_BEFORE_KEY}`]: new Date(Date.now() - 1) } },
    );
    await expect(
      service.updateTrainingData(
        { datasetId: String(datasetId), mode: 'qa', options: { timeoutMs: 5_000 } },
        context,
      ),
    ).resolves.toEqual({ acceptedCount: 1 });
    expect((await model.findById(taskId).lean())?.errorMsg).toBeNull();
    await expect(
      service.claimJob({ taskId, options: { timeoutMs: 5_000 } }, requestContext(teamA, 'retry')),
    ).resolves.toMatchObject({ taskId });
  });

  it('keeps stable sync job facts idempotent across repeated sync scans and teams', async () => {
    const collection: CollectionSnapshot = {
      collectionId: String(collectionId),
      teamId: String(teamA),
      datasetId: String(datasetId),
      parentId: null,
      type: 'link',
      name: 'link',
      tagIds: [],
      version: 1,
      createTime: new Date().toISOString(),
      updateTime: new Date().toISOString(),
    };
    const queue = new FakeQueue();
    const sync = new DatasetSyncApplicationService({
      collections: {
        get: async () => collection,
        list: async () => ({ total: 1, list: [collection], cursor: null }),
        create: async () => ({ collectionId: collection.collectionId }),
        update: async () => ({ version: 2 }),
        deleteTree: async () => ({ deleteJobId: 'delete' }),
      },
      knowledgeBase: {
        get: async () => ({
          datasetId: String(datasetId),
          teamId: String(teamA),
          parentId: null,
          type: 'knowledge',
          name: 'dataset',
          vectorModel: 'bge-m3',
          inheritPermission: true,
          autoSync: true,
          deleteTime: null,
          version: 1,
          createTime: new Date().toISOString(),
          updateTime: new Date().toISOString(),
        }),
        create: async () => ({ datasetId: String(datasetId), version: 1 }),
        update: async () => ({ version: 2 }),
        softDelete: async () => ({ deleteJobId: 'delete' }),
      },
      processingJobs: repository,
      queue,
    });
    const context = requestContext(teamA, 'sync-idempotent');
    await sync.sync(
      { datasetId: String(datasetId), idempotencyKey: 'idem-1', options: { timeoutMs: 5_000 } },
      context,
    );
    await sync.sync(
      { datasetId: String(datasetId), idempotencyKey: 'idem-2', options: { timeoutMs: 5_000 } },
      context,
    );

    expect(await model.countDocuments({ teamId: teamA })).toBe(2);
    expect(new Set(queue.calls.map((call) => call.jobId)).size).toBe(2);
    expect([...new Set(queue.calls.map((call) => call.jobId))].sort()).toEqual(
      [
        buildParseJobId(String(teamA), String(datasetId), String(collectionId), 1),
        buildChunkJobId(String(teamA), String(datasetId), String(collectionId), 1),
      ].sort(),
    );

    await repository.enqueue(
      {
        job: {
          jobId: 'cross-team-same-id',
          teamId: String(teamB),
          datasetId: String(new mongoose.Types.ObjectId()),
          collectionId: String(new mongoose.Types.ObjectId()),
          mode: 'chunk',
          expireAt: null,
          weight: 0,
        },
        options: { timeoutMs: 5_000 },
      },
      requestContext(teamB, 'team-b-enqueue'),
    );
    expect(await model.countDocuments({ teamId: teamB })).toBe(1);
  });

  it('allows only one concurrent claim across independent repository connections', async () => {
    const second = await createConnection();
    try {
      const { taskId } = await enqueue({ jobId: 'concurrent-claim' });
      const results = await Promise.allSettled([
        repository.claim(
          { taskId, options: { timeoutMs: 5_000 } },
          requestContext(teamA, 'claim-a'),
        ),
        second.repository.claim(
          { taskId, options: { timeoutMs: 5_000 } },
          requestContext(teamA, 'claim-b'),
        ),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect((await model.findById(taskId).lean())?.retryCount).toBe(4);
    } finally {
      await second.connection.close();
    }
  });

  it('recovers after process restart without letting the old lease commit', async () => {
    const first = await createConnection();
    const second = await createConnection();
    try {
      const context = requestContext(teamA, 'restart');
      const enqueued = await first.service.enqueueJob(
        {
          job: {
            jobId: 'restart-claim',
            teamId: String(teamA),
            datasetId: String(datasetId),
            collectionId: String(collectionId),
            mode: 'chunk',
            expireAt: null,
            weight: 0,
          },
          options: { timeoutMs: 5_000 },
        },
        context,
      );
      const oldLease = await first.service.claimJob(
        { taskId: enqueued.taskId, options: { timeoutMs: 5_000 } },
        context,
      );
      await first.connection.close();

      await expectApiError(
        second.service.claimJob(
          { taskId: enqueued.taskId, options: { timeoutMs: 5_000 } },
          requestContext(teamA, 'restart-early'),
        ),
        501005,
      );
      await second.model.updateOne(
        { _id: enqueued.taskId },
        { $set: { lockTime: new Date(Date.now() - PROCESSING_LEASE_MS - 1) } },
      );
      const newLease = await second.service.claimJob(
        { taskId: enqueued.taskId, options: { timeoutMs: 5_000 } },
        requestContext(teamA, 'restart-late'),
      );
      await expectApiError(
        second.repository.finishWithLease(
          {
            taskId: enqueued.taskId,
            lockTime: oldLease.lockTime,
            state: 'success',
            options: { timeoutMs: 5_000 },
          },
          context,
        ),
        501005,
      );
      await second.repository.finishWithLease(
        {
          taskId: enqueued.taskId,
          lockTime: newLease.lockTime,
          state: 'success',
          options: { timeoutMs: 5_000 },
        },
        context,
      );
      expect(await second.model.findById(enqueued.taskId)).toBeNull();
    } finally {
      if (first.connection.readyState === 1) await first.connection.close();
      if (second.connection.readyState === 1) await second.connection.close();
    }
  });

  it('does not expose task existence across team boundaries', async () => {
    const { taskId } = await enqueue({ jobId: 'tenant-a-only' });
    const teamBContext = requestContext(teamB, 'team-b');
    await expectApiError(
      repository.getTaskDetail({ taskId, options: { timeoutMs: 5_000 } }, teamBContext),
      501070,
    );
    await expectApiError(
      repository.claim({ taskId, options: { timeoutMs: 5_000 } }, teamBContext),
      501070,
    );
    await expect(
      repository.listTaskErrors({ taskId, limit: 20, options: { timeoutMs: 5_000 } }, teamBContext),
    ).resolves.toMatchObject({ total: 0, list: [] });
  });
});
