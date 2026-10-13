import { ApiErrorException, createApiError } from '@kb/contracts';
import type { QueuePort } from '@kb/dal';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ObjectStorePort, VectorController } from '../../src/ports/capabilities';
import type { PortCallOptions, RequestContext } from '../../src/ports/types';
import { DeleteApplicationService } from '../../src/modules/delete/application/delete.service';
import { MongoCrossStoreOperationRepository } from '../../src/modules/delete/repository/mongo-cross-store-operation.repository';
import { MongoDeleteFactsRepository } from '../../src/modules/delete/repository/mongo-delete-facts.repository';
import { MongoDeleteJobRepository } from '../../src/modules/delete/repository/mongo-delete-job.repository';
import {
  CrossStoreOperationSchema,
  DatasetAclSchema,
  DatasetCollectionSchema,
  DatasetDataSchema,
  DatasetDataTextSchema,
  DatasetDeleteFailureSchema,
  DatasetDeleteJobSchema,
  DatasetSchema,
  DatasetTrainingSchema,
  ImageAssetSchema,
  type CrossStoreOperationDoc,
  type DatasetAclDoc,
  type DatasetCollectionDoc,
  type DatasetDataDoc,
  type DatasetDataTextDoc,
  type DatasetDeleteFailureDoc,
  type DatasetDeleteJobDoc,
  type DatasetDoc,
  type DatasetTrainingDoc,
  type ImageAssetDoc,
} from '../../src/shared/persistence/schemas';
import { DEFAULT_CHUNK_POLICY } from '../../src/shared/persistence/schemas/common';

const teamId = new mongoose.Types.ObjectId();
const otherTeamId = new mongoose.Types.ObjectId();
const createdBy = new mongoose.Types.ObjectId();

const context: RequestContext = {
  requestId: 'req-delete-orchestration',
  tenant: {
    teamId: String(teamId),
    tmbId: String(createdBy),
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const otherContext: RequestContext = {
  ...context,
  requestId: 'req-delete-orchestration-other',
  tenant: { ...context.tenant, teamId: String(otherTeamId) },
};

const options: PortCallOptions = { timeoutMs: 10_000 };

let replSet: MongoMemoryReplSet;
let connection: mongoose.Connection;
let datasets: mongoose.Model<DatasetDoc>;
let collections: mongoose.Model<DatasetCollectionDoc>;
let datas: mongoose.Model<DatasetDataDoc>;
let texts: mongoose.Model<DatasetDataTextDoc>;
let trainings: mongoose.Model<DatasetTrainingDoc>;
let acls: mongoose.Model<DatasetAclDoc>;
let imageAssets: mongoose.Model<ImageAssetDoc>;
let jobs: mongoose.Model<DatasetDeleteJobDoc>;
let failures: mongoose.Model<DatasetDeleteFailureDoc>;
let operations: mongoose.Model<CrossStoreOperationDoc>;

class FakeQueue {
  readonly calls: Array<{ queue: string; jobId: string; payload: unknown }> = [];

  async enqueue(
    queue: string,
    jobId: string,
    payload: unknown,
  ): Promise<{
    jobId: string;
    enqueued: boolean;
  }> {
    this.calls.push({ queue, jobId, payload });
    return { jobId, enqueued: true };
  }

  async remove(): Promise<void> {}

  async close(): Promise<void> {}
}

class FakeVectorController {
  readonly deleted: Array<Record<string, unknown>> = [];
  failNext = false;

  async delete(input: Record<string, unknown>): Promise<{ deleted: number }> {
    if (this.failNext) {
      throw new ApiErrorException(
        createApiError({
          code: 501016,
          requestId: 'vector-fault',
          params: { store: 'pgvector', operation: 'delete' },
        }),
      );
    }
    this.deleted.push(input);
    return { deleted: 1 };
  }
}

function fakeObjectStore(): { port: ObjectStorePort; deletedKeys: string[] } {
  const deletedKeys: string[] = [];
  const port = {
    async delete(input: { ref: { key: string } }): Promise<{ deleted: boolean }> {
      deletedKeys.push(input.ref.key);
      return { deleted: true };
    },
  } as unknown as ObjectStorePort;
  return { port, deletedKeys };
}

interface Harness {
  service: DeleteApplicationService;
  queue: FakeQueue;
  vector: FakeVectorController;
  objectStoreDeleted: string[];
  cleanupCalls: string[];
  jobStore: MongoDeleteJobRepository;
}

function harness(): Harness {
  const queue = new FakeQueue();
  const vector = new FakeVectorController();
  const store = fakeObjectStore();
  const cleanupCalls: string[] = [];
  const jobStore = new MongoDeleteJobRepository(connection);
  const service = new DeleteApplicationService({
    jobs: jobStore,
    crossStore: new MongoCrossStoreOperationRepository(connection),
    facts: new MongoDeleteFactsRepository(connection),
    queue: queue as unknown as QueuePort,
    vectorController: vector as unknown as VectorController,
    objectStore: store.port,
    syncSchedulerCleanup: async (datasetId) => {
      cleanupCalls.push(datasetId);
    },
  });
  return { service, queue, vector, objectStoreDeleted: store.deletedKeys, cleanupCalls, jobStore };
}

async function seedDataset(): Promise<{
  datasetId: mongoose.Types.ObjectId;
  collectionId: mongoose.Types.ObjectId;
  dataId: mongoose.Types.ObjectId;
}> {
  const dataset = await datasets.create({
    teamId,
    createdBy,
    type: 'knowledge',
    name: 'dataset-a',
    vectorModel: 'bge-m3',
    indexVersion: 'v1',
    chunkPolicy: DEFAULT_CHUNK_POLICY,
  });
  const collection = await collections.create({
    teamId,
    datasetId: dataset._id,
    type: 'file',
    name: 'collection-a',
    trainingPolicy: DEFAULT_CHUNK_POLICY,
  });
  const data = await datas.create({
    teamId,
    datasetId: dataset._id,
    collectionId: collection._id,
    q: 'q',
    a: 'a',
    indexes: [
      {
        indexId: 'idx-1',
        type: 'custom',
        dataId: String(new mongoose.Types.ObjectId()),
        text: 't',
      },
    ],
  });
  await texts.create({
    teamId,
    datasetId: dataset._id,
    collectionId: collection._id,
    dataId: data._id,
    fullTextToken: 'token',
  });
  await trainings.create({
    teamId,
    datasetId: dataset._id,
    collectionId: collection._id,
    mode: 'parse',
    expireAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  });
  await acls.create({
    teamId,
    resourceType: 'dataset',
    resourceId: dataset._id,
    collaboratorType: 'member',
    collaboratorId: new mongoose.Types.ObjectId(),
  });
  await imageAssets.create({
    imageId: 'img-1',
    teamId,
    datasetId: dataset._id,
    objectKey: `dataset/${String(dataset._id)}/img-1.png`,
    mimeType: 'image/png',
    size: 12,
  });
  return { datasetId: dataset._id, collectionId: collection._id, dataId: data._id };
}

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  connection = mongoose.createConnection(replSet.getUri('kb_delete_orchestration'));
  await connection.asPromise();
  datasets = connection.model<DatasetDoc>('Dataset', DatasetSchema);
  collections = connection.model<DatasetCollectionDoc>(
    'DatasetCollection',
    DatasetCollectionSchema,
  );
  datas = connection.model<DatasetDataDoc>('DatasetData', DatasetDataSchema);
  texts = connection.model<DatasetDataTextDoc>('DatasetDataText', DatasetDataTextSchema);
  trainings = connection.model<DatasetTrainingDoc>('DatasetTraining', DatasetTrainingSchema);
  acls = connection.model<DatasetAclDoc>('DatasetAcl', DatasetAclSchema);
  imageAssets = connection.model<ImageAssetDoc>('ImageAsset', ImageAssetSchema);
  jobs = connection.model<DatasetDeleteJobDoc>('DatasetDeleteJob', DatasetDeleteJobSchema);
  failures = connection.model<DatasetDeleteFailureDoc>(
    'DatasetDeleteFailure',
    DatasetDeleteFailureSchema,
  );
  operations = connection.model<CrossStoreOperationDoc>(
    'CrossStoreOperation',
    CrossStoreOperationSchema,
  );
  await Promise.all([jobs.init(), operations.init(), imageAssets.init(), acls.init()]);
}, 300_000);

beforeEach(async () => {
  await Promise.all([
    datasets.deleteMany({}),
    collections.deleteMany({}),
    datas.deleteMany({}),
    texts.deleteMany({}),
    trainings.deleteMany({}),
    acls.deleteMany({}),
    imageAssets.deleteMany({}),
    jobs.deleteMany({}),
    failures.deleteMany({}),
    operations.deleteMany({}),
  ]);
});

afterAll(async () => {
  await connection.close();
  await replSet.stop();
});

describe('删除编排与状态机（P6-01 / 设计 7.9 / 14.6）', () => {
  it('事务提交后 queued：派生表清理、软删标记、cross_store_operations 三条', async () => {
    const { datasetId, dataId } = await seedDataset();
    const { service, queue, cleanupCalls } = harness();

    const result = await service.requestDatasetDelete(
      { datasetId: String(datasetId), options },
      context,
    );
    expect(result).toEqual({
      jobId: `${String(teamId)}:${String(datasetId)}:delete`,
      state: 'queued',
    });

    const job = await jobs.findOne({ teamId, jobId: result.jobId }).lean();
    expect(job?.state).toBe('queued');
    expect(job?.stage).toBe('mongo');
    const dataset = await datasets.findById(datasetId).lean();
    expect(dataset?.deleteTime).not.toBeNull();
    expect(await collections.countDocuments({ teamId, datasetId })).toBe(0);
    expect(await datas.countDocuments({ teamId, datasetId })).toBe(0);
    expect(await texts.countDocuments({ teamId, datasetId })).toBe(0);
    expect(await trainings.countDocuments({ teamId, datasetId })).toBe(0);
    expect(await acls.countDocuments({ teamId, resourceId: datasetId })).toBe(0);

    const ops = await operations.find({ teamId }).sort({ operation: 1 }).lean();
    expect(ops).toHaveLength(3);
    expect(ops.map((op) => `${op.operation}:${op.stage}`).sort()).toEqual([
      'delete_s3:prepared',
      'delete_vector:prepared',
      'switch_ref:mongo_committed',
    ]);
    expect(queue.calls).toHaveLength(1);
    expect(queue.calls[0]?.payload).toMatchObject({
      jobId: result.jobId,
      stage: 'vector',
      scope: { kind: 'dataset', datasetId: String(datasetId) },
    });
    expect(cleanupCalls).toEqual([String(datasetId)]);
    expect(
      await operations.countDocuments({
        teamId,
        operation: 'delete_vector',
        'resourceRef.resourceId': String(dataId),
      }),
    ).toBe(1);
  });

  it('事务内故障整体回滚：软删标记、派生表、任务与操作记录均不落库', async () => {
    const { datasetId } = await seedDataset();
    const facts = new MongoDeleteFactsRepository(connection) as unknown as {
      prepareCrossStoreOperations: (...args: unknown[]) => Promise<void>;
    };
    facts.prepareCrossStoreOperations = async () => {
      throw new Error('injected-transaction-failure');
    };
    const failingService = new DeleteApplicationService({
      jobs: new MongoDeleteJobRepository(connection),
      crossStore: new MongoCrossStoreOperationRepository(connection),
      facts: facts as unknown as MongoDeleteFactsRepository,
      queue: new FakeQueue() as unknown as QueuePort,
      vectorController: new FakeVectorController() as unknown as VectorController,
      objectStore: fakeObjectStore().port,
      syncSchedulerCleanup: async () => undefined,
    });

    await expect(
      failingService.requestDatasetDelete({ datasetId: String(datasetId), options }, context),
    ).rejects.toThrow('injected-transaction-failure');

    const dataset = await datasets.findById(datasetId).lean();
    expect(dataset?.deleteTime).toBeNull();
    expect(await datas.countDocuments({ teamId, datasetId })).toBe(1);
    expect(await texts.countDocuments({ teamId, datasetId })).toBe(1);
    expect(await trainings.countDocuments({ teamId, datasetId })).toBe(1);
    expect(await collections.countDocuments({ teamId, datasetId })).toBe(1);
    expect(await jobs.countDocuments({ teamId })).toBe(0);
    expect(await operations.countDocuments({ teamId })).toBe(0);
  });

  it('deleting 重复请求 501068；completed 幂等返回同一 jobId', async () => {
    const { datasetId } = await seedDataset();
    const { service } = harness();
    const first = await service.requestDatasetDelete(
      { datasetId: String(datasetId), options },
      context,
    );

    await expect(
      service.requestDatasetDelete({ datasetId: String(datasetId), options }, context),
    ).rejects.toMatchObject({ error: { code: 501068 } });

    const jobStore = new MongoDeleteJobRepository(connection);
    const claimed = await jobStore.claimWithLease(
      { jobId: first.jobId, leaseOwner: 'worker-1', leaseMs: 60_000, now: new Date() },
      context,
    );
    expect(claimed?.state).toBe('deleting');

    await expect(
      service.requestDatasetDelete({ datasetId: String(datasetId), options }, context),
    ).rejects.toMatchObject({ error: { code: 501068 } });

    await jobStore.releaseLease(
      { jobId: first.jobId, leaseOwner: 'worker-1', now: new Date() },
      context,
    );
    const cleanup = await service.runCleanup(
      { jobId: first.jobId, scope: { kind: 'dataset', datasetId: String(datasetId) }, options },
      context,
    );
    expect(cleanup.failed).toBe(0);
    const job = await jobs.findOne({ teamId, jobId: first.jobId }).lean();
    expect(job?.state).toBe('completed');

    const repeat = await service.requestDatasetDelete(
      { datasetId: String(datasetId), options },
      context,
    );
    expect(repeat).toEqual({ jobId: first.jobId, state: 'completed' });
  });

  it('并发两次 claimWithLease 仅一次成功；租约过期可接管', async () => {
    const { datasetId } = await seedDataset();
    const { service } = harness();
    const created = await service.requestDatasetDelete(
      { datasetId: String(datasetId), options },
      context,
    );
    const jobStore = new MongoDeleteJobRepository(connection);
    const now = new Date();

    const [first, second] = await Promise.all([
      jobStore.claimWithLease(
        { jobId: created.jobId, leaseOwner: 'worker-a', leaseMs: 60_000, now },
        context,
      ),
      jobStore.claimWithLease(
        { jobId: created.jobId, leaseOwner: 'worker-b', leaseMs: 60_000, now },
        context,
      ),
    ]);
    expect([first, second].filter((claim) => claim !== null)).toHaveLength(1);

    const takeover = await jobStore.claimWithLease(
      {
        jobId: created.jobId,
        leaseOwner: 'worker-c',
        leaseMs: 60_000,
        now: new Date(now.getTime() + 61_000),
      },
      context,
    );
    expect(takeover?.leaseOwner).toBe('worker-c');
    const job = await jobs.findOne({ teamId, jobId: created.jobId }).lean();
    expect(job?.state).toBe('deleting');
    expect(job?.attempt).toBe(0);
  });

  it('清理失败写失败事实源；attempt≥10 置 failed 且不再重排', async () => {
    const { datasetId } = await seedDataset();
    const { service, queue, vector } = harness();
    const created = await service.requestDatasetDelete(
      { datasetId: String(datasetId), options },
      context,
    );
    await jobs.updateOne({ teamId, jobId: created.jobId }, { $set: { attempt: 10 } });
    vector.failNext = true;
    const queueCallsBefore = queue.calls.length;

    const stats = await service.runCleanup(
      { jobId: created.jobId, scope: { kind: 'dataset', datasetId: String(datasetId) }, options },
      context,
    );
    expect(stats.failed).toBe(1);
    const job = await jobs.findOne({ teamId, jobId: created.jobId }).lean();
    expect(job?.state).toBe('failed');
    expect(await failures.countDocuments({ teamId, jobId: created.jobId })).toBe(1);
    expect(queue.calls.length).toBe(queueCallsBefore);

    const reclaim = await new MongoDeleteJobRepository(connection).claimWithLease(
      { jobId: created.jobId, leaseOwner: 'worker-x', leaseMs: 60_000, now: new Date() },
      context,
    );
    expect(reclaim).toBeNull();
    const failedOps = await operations.countDocuments({ teamId, stage: 'failed' });
    expect(failedOps).toBe(3);
  });

  it('retryDeleteJob：无失败项 501040；有失败项 resetRetry + resetNextAttempt + 重新入队', async () => {
    const { datasetId } = await seedDataset();
    const { service, queue } = harness();
    const created = await service.requestDatasetDelete(
      { datasetId: String(datasetId), options },
      context,
    );
    await expect(
      service.retryDeleteJob({ jobId: created.jobId, options }, context),
    ).rejects.toMatchObject({ error: { code: 501040 } });

    await jobs.updateOne({ teamId, jobId: created.jobId }, { $set: { state: 'failed' } });
    await failures.create({
      teamId,
      jobId: created.jobId,
      resourceType: 'dataset',
      resourceId: String(datasetId),
      stage: 'vector',
      attempt: 0,
      errorClass: 'dataset.storage.s3_error',
      retryable: true,
      lastError: 'fault',
    });
    const future = new Date(Date.now() + 3_600_000);
    await operations.updateMany({ teamId }, { $set: { nextAttemptAt: future } });
    queue.calls.length = 0;

    const retried = await service.retryDeleteJob({ jobId: created.jobId, options }, context);
    expect(retried).toEqual({ jobId: created.jobId, state: 'queued' });
    const job = await jobs.findOne({ teamId, jobId: created.jobId }).lean();
    expect(job?.state).toBe('queued');
    expect(job?.attempt).toBe(1);
    expect(queue.calls.map((call) => call.jobId)).toEqual([created.jobId]);
    const rescheduled = await operations.find({ teamId }).lean();
    expect(rescheduled.every((op) => op.nextAttemptAt.getTime() < future.getTime())).toBe(true);
  });

  it('跨租户查询 501070（TEST-RECON-ACL-001 / TEST-E2E-DELETE-001 语义）', async () => {
    const { datasetId } = await seedDataset();
    const { service } = harness();
    const created = await service.requestDatasetDelete(
      { datasetId: String(datasetId), options },
      context,
    );

    await expect(
      service.getDeleteJob({ jobId: created.jobId, options }, otherContext),
    ).rejects.toMatchObject({ error: { code: 501070 } });
    await expect(
      service.requestDatasetDelete({ datasetId: String(datasetId), options }, otherContext),
    ).rejects.toMatchObject({ error: { code: 501070 } });
  });
});
