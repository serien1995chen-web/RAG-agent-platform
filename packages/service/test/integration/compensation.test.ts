import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  FailureQueryPort,
  ObjectStorePort,
  VectorController,
} from '../../src/ports/capabilities';
import type { RequestContext } from '../../src/ports/types';
import { FailureQueryAdapter } from '../../src/modules/delete/adapter/failure-query.adapter';
import { CompensationApplicationService } from '../../src/modules/delete/application/compensation.service';
import { MongoCrossStoreOperationRepository } from '../../src/modules/delete/repository/mongo-cross-store-operation.repository';
import { MongoDeleteFactsRepository } from '../../src/modules/delete/repository/mongo-delete-facts.repository';
import {
  CrossStoreOperationSchema,
  DatasetDataSchema,
  DatasetDeleteFailureSchema,
  DatasetSchema,
  type CrossStoreOperationDoc,
  type DatasetDataDoc,
  type DatasetDeleteFailureDoc,
  type DatasetDoc,
} from '../../src/shared/persistence/schemas';

const teamId = new mongoose.Types.ObjectId();
const otherTeamId = new mongoose.Types.ObjectId();

const context: RequestContext = {
  requestId: 'req-compensation',
  tenant: {
    teamId: String(teamId),
    tmbId: String(new mongoose.Types.ObjectId()),
    authType: 'internal',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
};

const fixedNow = new Date('2026-10-14T12:00:00.000Z');

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let operations: mongoose.Model<CrossStoreOperationDoc>;
let failures: mongoose.Model<DatasetDeleteFailureDoc>;
let datasets: mongoose.Model<DatasetDoc>;
let datas: mongoose.Model<DatasetDataDoc>;

class FakeVectors {
  readonly deleteCalls: Array<Record<string, unknown>> = [];
  deleteThrows = false;

  async delete(
    input: { datasetId?: string; dataIds?: string[] },
    context: RequestContext,
  ): Promise<{ deleted: number }> {
    if (this.deleteThrows) throw new Error('vector-delete-failed');
    if (input.datasetId === undefined || context.tenant.teamId === '') {
      throw new Error('vector-delete-missing-dataset-context');
    }
    this.deleteCalls.push(input);
    return { deleted: 1 };
  }
}

interface StoreState {
  deleteCalls: string[];
  deleteThrows: boolean;
}

function fakeObjectStore(state: StoreState): ObjectStorePort {
  return {
    async delete(input: {
      ref: { key: string };
      datasetId?: string;
    }): Promise<{ deleted: boolean }> {
      if (state.deleteThrows) throw new Error('s3-delete-failed');
      const [prefix, datasetId] = input.ref.key.split('/');
      if (prefix === 'dataset' && datasetId !== input.datasetId) {
        throw new Error('s3-delete-missing-dataset-context');
      }
      state.deleteCalls.push(input.ref.key);
      return { deleted: true };
    },
  } as unknown as ObjectStorePort;
}

interface Harness {
  service: CompensationApplicationService;
  vectors: FakeVectors;
  store: StoreState;
  liveReferenceCalls: Array<Record<string, unknown>>;
}

function harness(
  options: {
    live?: boolean;
    formal?: boolean;
    vectorThrows?: boolean;
  } = {},
): Harness {
  const vectors = new FakeVectors();
  vectors.deleteThrows = options.vectorThrows ?? false;
  const store: StoreState = { deleteCalls: [], deleteThrows: false };
  const liveReferenceCalls: Array<Record<string, unknown>> = [];
  const service = new CompensationApplicationService({
    crossStore: new MongoCrossStoreOperationRepository(connection),
    vectorController: vectors as unknown as VectorController,
    objectStore: fakeObjectStore(store),
    hasFormalReference: async () => options.formal ?? false,
    hasLiveReference: async (input) => {
      liveReferenceCalls.push(input);
      return options.live ?? false;
    },
    clock: () => fixedNow,
    leaseOwner: 'comp-fixed',
  });
  return { service, vectors, store, liveReferenceCalls };
}

async function seedOperation(
  overrides: Partial<CrossStoreOperationDoc> & { operationId: string },
): Promise<void> {
  await operations.create({
    teamId,
    resourceRef: {
      resourceType: 'data',
      resourceId: String(new mongoose.Types.ObjectId()),
      version: 1,
    },
    operation: 'delete_vector',
    stage: 'prepared',
    attempt: 0,
    nextAttemptAt: fixedNow,
    leaseOwner: null,
    leaseExpireAt: null,
    ...overrides,
  });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongo.getUri('kb_compensation'));
  await connection.asPromise();
  operations = connection.model<CrossStoreOperationDoc>(
    'CrossStoreOperation',
    CrossStoreOperationSchema,
  );
  failures = connection.model<DatasetDeleteFailureDoc>(
    'DatasetDeleteFailure',
    DatasetDeleteFailureSchema,
  );
  datasets = connection.model<DatasetDoc>('Dataset', DatasetSchema);
  datas = connection.model<DatasetDataDoc>('DatasetData', DatasetDataSchema);
  await Promise.all([operations.init(), failures.init()]);
}, 300_000);

beforeEach(async () => {
  await Promise.all([
    operations.deleteMany({}),
    failures.deleteMany({}),
    datasets.deleteMany({}),
    datas.deleteMany({}),
  ]);
});

afterAll(async () => {
  await connection.close();
  await mongo.stop();
});

describe('失败记录与跨存储补偿（P6-06 / 设计 14.5 / 14.9）', () => {
  it('Mongo 提交失败后 switch_ref 重放收敛，无悬空引用（TEST-FI-MONGO-001 / ACC-RULE-003）', async () => {
    const datasetId = new mongoose.Types.ObjectId();
    await seedOperation({
      operationId: `switch-ref:${String(teamId)}:${String(datasetId)}:1`,
      operation: 'switch_ref',
      stage: 'mongo_committed',
      resourceRef: { resourceType: 'dataset', resourceId: String(datasetId), version: 1 },
    });
    const { service, liveReferenceCalls } = harness({ live: false });
    const stats = await service.sweepOnce(context);
    expect(stats.cleaned).toBe(1);
    expect(liveReferenceCalls).toEqual([{ datasetId: String(datasetId) }]);
    const op = await operations.findOne({ teamId }).lean();
    expect(op?.stage).toBe('cleaned');
  });

  it('S3 删除失败按 lease 重试并最终 cleaned（TEST-FI-S3-001 / ACC-DELETE-004）', async () => {
    const key = `dataset/${String(new mongoose.Types.ObjectId())}/file.bin`;
    await seedOperation({
      operationId: `delete-s3:${String(teamId)}:abc123:1`,
      operation: 'delete_s3',
      resourceRef: { resourceType: 'object', resourceId: key, version: 1 },
    });
    let now = fixedNow;
    const vectors = new FakeVectors();
    const store: StoreState = { deleteCalls: [], deleteThrows: true };
    const service = new CompensationApplicationService({
      crossStore: new MongoCrossStoreOperationRepository(connection),
      vectorController: vectors as unknown as VectorController,
      objectStore: fakeObjectStore(store),
      hasFormalReference: async () => false,
      clock: () => now,
    });
    const first = await service.sweepOnce(context);
    expect(first.failed).toBe(1);
    const afterFailure = await operations.findOne({ teamId }).lean();
    expect(afterFailure?.stage).toBe('prepared');
    expect(afterFailure?.attempt).toBe(1);
    expect(afterFailure?.nextAttemptAt.getTime()).toBe(fixedNow.getTime() + 60_000);

    store.deleteThrows = false;
    now = new Date(fixedNow.getTime() + 60_000);
    const second = await service.sweepOnce(context);
    expect(second.cleaned).toBe(1);
    expect(store.deleteCalls).toEqual([key]);
    expect((await operations.findOne({ teamId }).lean())?.stage).toBe('cleaned');
  });

  it('operationId 幂等：重复 sweep 不重复执行已 cleaned 操作（TEST-CROSSSTORE-001）', async () => {
    const dataId = String(new mongoose.Types.ObjectId());
    const datasetId = String(new mongoose.Types.ObjectId());
    await seedOperation({
      operationId: `delete-vector:${String(teamId)}:${datasetId}:${dataId}:1`,
      resourceRef: { resourceType: 'data', resourceId: dataId, version: 1 },
    });
    const { service, vectors } = harness();
    const first = await service.sweepOnce(context);
    expect(first.cleaned).toBe(1);
    expect(vectors.deleteCalls).toHaveLength(1);
    expect(vectors.deleteCalls[0]).toMatchObject({ datasetId, dataIds: [dataId] });
    const second = await service.sweepOnce(context);
    expect(second.scanned).toBe(0);
    expect(vectors.deleteCalls).toHaveLength(1);
  });

  it('lease 过期可被接管、未过期不可抢占（ACC-REL-005）', async () => {
    const dataId = String(new mongoose.Types.ObjectId());
    const datasetId = String(new mongoose.Types.ObjectId());
    await seedOperation({
      operationId: `delete-vector:${String(teamId)}:${datasetId}:${dataId}:1`,
      resourceRef: { resourceType: 'data', resourceId: dataId, version: 1 },
      leaseOwner: 'worker-x',
      leaseExpireAt: new Date(fixedNow.getTime() + 600_000),
    });
    const { service, vectors } = harness();
    const blocked = await service.sweepOnce(context);
    expect(blocked.scanned).toBe(0);
    expect(vectors.deleteCalls).toHaveLength(0);

    await operations.updateOne(
      { teamId },
      { $set: { leaseExpireAt: new Date(fixedNow.getTime() - 1000) } },
    );
    const takeover = await service.sweepOnce(context);
    expect(takeover.cleaned).toBe(1);
  });

  it('attempt≥10 置 failed 并进入对账 finding 来源（ACC-DELETE-005）', async () => {
    const dataId = String(new mongoose.Types.ObjectId());
    const datasetId = String(new mongoose.Types.ObjectId());
    const operationId = `delete-vector:${String(teamId)}:${datasetId}:${dataId}:1`;
    await seedOperation({
      operationId,
      resourceRef: { resourceType: 'data', resourceId: dataId, version: 1 },
      attempt: 9,
    });
    const { service } = harness({ vectorThrows: true });
    await service.sweepOnce(context);
    const op = await operations.findOne({ teamId }).lean();
    expect(op?.stage).toBe('failed');
    expect(op?.attempt).toBe(10);

    const facts = new MongoDeleteFactsRepository(connection);
    const findings = await facts.scanFailedCrossStoreOps({
      kind: 'dataset',
      teamId: String(teamId),
    });
    expect(findings.map((finding) => finding.operationId)).toContain(operationId);
    const again = await service.sweepOnce(context);
    expect(again.scanned).toBe(0);
  });

  it('跨租户 op 不重放：operationId 内 teamId 与事实 teamId 不一致即拒绝', async () => {
    const dataId = String(new mongoose.Types.ObjectId());
    const datasetId = String(new mongoose.Types.ObjectId());
    await seedOperation({
      operationId: `delete-vector:${String(otherTeamId)}:${datasetId}:${dataId}:1`,
      resourceRef: { resourceType: 'data', resourceId: dataId, version: 1 },
    });
    const { service, vectors } = harness();
    const stats = await service.sweepOnce(context);
    expect(stats.skipped).toBe(1);
    expect(vectors.deleteCalls).toHaveLength(0);
    const op = await operations.findOne({ teamId }).lean();
    expect(op?.stage).toBe('prepared');
  });

  it('retryFailedResources 仅重排失败资源、不覆盖已提交事实（ACC-DELETE-005）', async () => {
    const datasetId = new mongoose.Types.ObjectId();
    const jobId = `${String(teamId)}:${String(datasetId)}:delete`;
    const failedOpId = `delete-vector:${String(teamId)}:${String(datasetId)}:data-1:1`;
    await seedOperation({
      operationId: failedOpId,
      resourceRef: { resourceType: 'data', resourceId: 'data-1', version: 1 },
      stage: 'failed',
      attempt: 2,
      nextAttemptAt: new Date(fixedNow.getTime() + 7_200_000),
    });
    await seedOperation({
      operationId: `switch-ref:${String(teamId)}:${String(datasetId)}:1`,
      operation: 'switch_ref',
      stage: 'mongo_committed',
      resourceRef: { resourceType: 'dataset', resourceId: String(datasetId), version: 1 },
      nextAttemptAt: new Date(fixedNow.getTime() - 3_600_000),
    });
    const { service } = harness();
    const result = await service.retryFailedResources({ jobId }, context);
    expect(result.rescheduled).toBe(1);
    const failedOp = await operations.findOne({ operationId: failedOpId }).lean();
    expect(failedOp?.stage).toBe('failed');
    expect(failedOp?.nextAttemptAt.getTime()).toBe(fixedNow.getTime());
    const committed = await operations.findOne({ operation: 'switch_ref' }).lean();
    expect(committed?.stage).toBe('mongo_committed');
    expect(committed?.nextAttemptAt.getTime()).toBe(fixedNow.getTime() - 3_600_000);
  });

  it('FailureQueryPort 分页稳定且只读（ACC-DELETE-004）', async () => {
    const jobId = `${String(teamId)}:job-1:delete`;
    for (const offset of [0, 1000, 2000]) {
      await failures.create({
        teamId,
        jobId,
        resourceType: 'data',
        resourceId: `data-${offset}`,
        stage: 'vector',
        attempt: 1,
        errorClass: 'dataset.storage.s3_error',
        retryable: true,
        lastError: 'fault',
        createTime: new Date(fixedNow.getTime() + offset),
        updateTime: fixedNow,
      });
    }
    const adapter: FailureQueryPort = new FailureQueryAdapter(connection);
    const first = await adapter.query(
      { scope: { jobId }, limit: 2, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(first.total).toBe(3);
    expect(first.list).toHaveLength(2);
    expect(first.cursor).not.toBeNull();
    expect(first.list.map((item) => item.resourceId)).toEqual(['data-0', 'data-1000']);

    const second = await adapter.query(
      {
        scope: { jobId },
        cursor: first.cursor ?? undefined,
        limit: 2,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(second.list.map((item) => item.resourceId)).toEqual(['data-2000']);
    expect(second.cursor).toBeNull();
    expect(await failures.countDocuments({ teamId })).toBe(3);
  });
});
