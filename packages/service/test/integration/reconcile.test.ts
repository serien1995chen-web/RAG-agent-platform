import { ApiErrorException, createApiError } from '@kb/contracts';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import type { QueuePort } from '@kb/dal';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullTextStore, VectorController } from '../../src/ports/capabilities';
import type { RequestContext } from '../../src/ports/types';
import { ReconcileApplicationService } from '../../src/modules/delete/application/reconcile.service';
import type {
  S3ObjectDescriptor,
  SchedulerReconcileSummary,
} from '../../src/modules/delete/domain/findings';
import { MongoDeleteFactsRepository } from '../../src/modules/delete/repository/mongo-delete-facts.repository';
import { MongoReconcileReportRepository } from '../../src/modules/delete/repository/mongo-reconcile-report.repository';
import {
  CrossStoreOperationSchema,
  DatasetAclSchema,
  DatasetCollectionSchema,
  DatasetDataSchema,
  DatasetDataTextSchema,
  DatasetDeleteJobSchema,
  DatasetSchema,
  DatasetTrainingSchema,
  ImageAssetSchema,
  ReconcileReportSchema,
  type CrossStoreOperationDoc,
  type DatasetAclDoc,
  type DatasetCollectionDoc,
  type DatasetDataDoc,
  type DatasetDataTextDoc,
  type DatasetDeleteJobDoc,
  type DatasetDoc,
  type DatasetTrainingDoc,
  type ReconcileReportDoc,
} from '../../src/shared/persistence/schemas';
import { DEFAULT_CHUNK_POLICY } from '../../src/shared/persistence/schemas/common';

const routeFixture = vi.hoisted(() => ({
  teamId: '64b64b64b64b64b64b64b64b',
  runtime: undefined as unknown,
}));

vi.mock('../../../../projects/app/src/runtime', () => ({
  getRuntime: async () => routeFixture.runtime,
}));

import reconcileReportsRoute from '../../../../projects/app/src/pages/api/admin/dataset/reconcile/reports';

const teamId = new mongoose.Types.ObjectId(routeFixture.teamId);
const createdBy = new mongoose.Types.ObjectId();

const context: RequestContext = {
  requestId: 'req-reconcile',
  tenant: {
    teamId: String(teamId),
    tmbId: String(createdBy),
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const fixedNow = new Date('2026-10-14T12:00:00.000Z');
const sixHoursBefore = new Date(fixedNow.getTime() - 6 * 3_600_000);
const twoHoursBefore = new Date(fixedNow.getTime() - 2 * 3_600_000);

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let datasets: mongoose.Model<DatasetDoc>;
let collections: mongoose.Model<DatasetCollectionDoc>;
let datas: mongoose.Model<DatasetDataDoc>;
let texts: mongoose.Model<DatasetDataTextDoc>;
let trainings: mongoose.Model<DatasetTrainingDoc>;
let acls: mongoose.Model<DatasetAclDoc>;
let jobs: mongoose.Model<DatasetDeleteJobDoc>;
let operations: mongoose.Model<CrossStoreOperationDoc>;
let reports: mongoose.Model<ReconcileReportDoc>;

interface VectorRow {
  teamId: string;
  datasetId: string;
  collectionId: string;
  dataId: string;
}

interface HarnessOptions {
  vectorRows?: VectorRow[];
  vectorThrows?: boolean;
  scannerObjects?: Record<string, S3ObjectDescriptor[]>;
  scannerAbsent?: boolean;
  backfillThrows?: boolean;
  schedulerSummary?: SchedulerReconcileSummary | null;
}

class FakeVectors {
  readonly deleteCalls: Array<Record<string, unknown>> = [];

  constructor(private readonly options: HarnessOptions) {}

  async getVectorDataByTime(
    input: { teamId: string; datasetId: string },
    context: RequestContext,
  ): Promise<VectorRow[]> {
    if (
      context.tenant.teamId !== input.teamId ||
      input.datasetId === undefined ||
      input.datasetId === ''
    ) {
      throw new ApiErrorException(
        createApiError({
          code: 501012,
          requestId: 'vector-context',
          params: { missing: ['teamId'] },
        }),
      );
    }
    if (this.options.vectorThrows === true) {
      throw new ApiErrorException(
        createApiError({
          code: 501016,
          requestId: 'vector-scan-fault',
          params: { store: 'pgvector', operation: 'getVectorDataByTime' },
        }),
      );
    }
    return (this.options.vectorRows ?? []).filter((row) => row.datasetId === input.datasetId);
  }

  async delete(
    input: { datasetId?: string; dataIds?: string[] },
    context: RequestContext,
  ): Promise<{ deleted: number }> {
    if (input.datasetId === undefined || context.tenant.teamId === '') {
      throw new ApiErrorException(
        createApiError({
          code: 501012,
          requestId: 'vector-context',
          params: { missing: ['datasetId'] },
        }),
      );
    }
    this.deleteCalls.push(input);
    return { deleted: 1 };
  }
}

function harness(options: HarnessOptions = {}): {
  service: ReconcileApplicationService;
  vectors: FakeVectors;
  backfills: Array<Record<string, unknown>>;
  fullTextDeletes: string[];
  queueCalls: Array<{ queue: string; jobId: string; payload: unknown }>;
} {
  const vectors = new FakeVectors(options);
  const backfills: Array<Record<string, unknown>> = [];
  const fullTextDeletes: string[] = [];
  const queueCalls: Array<{ queue: string; jobId: string; payload: unknown }> = [];
  const fullTextStore = {
    async deleteByDataId(
      input: { dataId: string },
      context: RequestContext,
    ): Promise<{ deleted: number }> {
      const dataId = new mongoose.Types.ObjectId(input.dataId);
      const row = await texts.findOne({ dataId }).lean();
      if (row && String(row.teamId) !== context.tenant.teamId) {
        throw new ApiErrorException(
          createApiError({
            code: 501012,
            requestId: 'fulltext-context',
            params: { missing: ['teamId'] },
          }),
        );
      }
      const result = await texts.deleteMany({ dataId });
      fullTextDeletes.push(input.dataId);
      return { deleted: result.deletedCount ?? 0 };
    },
  } as unknown as FullTextStore;
  const service = new ReconcileApplicationService({
    facts: new MongoDeleteFactsRepository(connection),
    reports: new MongoReconcileReportRepository(connection),
    vectorController: vectors as unknown as VectorController,
    fullTextStore,
    ...(options.scannerAbsent === true
      ? {}
      : {
          s3OrphanScanner: {
            async listByPrefix(input: { prefix: string }): Promise<S3ObjectDescriptor[]> {
              return options.scannerObjects?.[input.prefix] ?? [];
            },
          },
        }),
    s3TtlBackfill: {
      async hasFormalReference(): Promise<boolean> {
        return false;
      },
      async backfill(input: Record<string, unknown>): Promise<void> {
        if (options.backfillThrows === true) {
          throw new ApiErrorException(
            createApiError({
              code: 501016,
              requestId: 'backfill-fault',
              params: { store: 's3', operation: 'backfill' },
            }),
          );
        }
        backfills.push(input);
      },
    },
    ...(options.schedulerSummary === null
      ? {}
      : {
          schedulerReconcileSummary: async () =>
            options.schedulerSummary ?? {
              created: 1,
              dropped: 0,
              skipped_missing: 0,
              skipped_mismatch: 0,
              error: 0,
            },
        }),
    deleteQueue: {
      async enqueue(queue: string, jobId: string, payload: unknown) {
        queueCalls.push({ queue, jobId, payload });
        return { jobId, enqueued: true };
      },
      async remove() {},
      async close() {},
    } as unknown as QueuePort,
    clock: () => fixedNow,
  });
  return { service, vectors, backfills, fullTextDeletes, queueCalls };
}

async function seedDataset(deleted = false): Promise<mongoose.Types.ObjectId> {
  const dataset = await datasets.create({
    teamId,
    createdBy,
    type: 'knowledge',
    name: deleted ? 'dataset-deleted' : 'dataset-live',
    vectorModel: 'bge-m3',
    indexVersion: 'v1',
    chunkPolicy: DEFAULT_CHUNK_POLICY,
    deleteTime: deleted ? fixedNow : null,
  });
  return dataset._id;
}

async function seedCollection(
  datasetId: mongoose.Types.ObjectId,
): Promise<mongoose.Types.ObjectId> {
  const collection = await collections.create({
    teamId,
    datasetId,
    type: 'file',
    name: 'collection',
    trainingPolicy: DEFAULT_CHUNK_POLICY,
  });
  return collection._id;
}

async function seedData(
  datasetId: mongoose.Types.ObjectId,
  collectionId: mongoose.Types.ObjectId,
  q = 'q',
): Promise<mongoose.Types.ObjectId> {
  const data = await datas.create({
    teamId,
    datasetId,
    collectionId,
    q,
    a: 'a',
    indexes: [],
  });
  return data._id;
}

async function seedOrphans(): Promise<void> {
  const liveDataset = await seedDataset();
  await seedCollection(liveDataset);
  const deletedDataset = await seedDataset(true);
  const extraCollection = await seedCollection(deletedDataset);
  await acls.create({
    teamId,
    resourceType: 'dataset',
    resourceId: deletedDataset,
    collaboratorType: 'member',
    collaboratorId: new mongoose.Types.ObjectId(),
  });
  await trainings.create({
    teamId,
    datasetId: deletedDataset,
    collectionId: extraCollection,
    mode: 'parse',
    expireAt: new Date(fixedNow.getTime() + 86_400_000),
  });
  await texts.create({
    teamId,
    datasetId: liveDataset,
    collectionId: new mongoose.Types.ObjectId(),
    dataId: new mongoose.Types.ObjectId(),
    createTime: new Date(fixedNow.getTime() - 3 * 3_600_000),
    fullTextToken: 'SECRET-TOKEN',
  });
  await jobs.create({
    jobId: `${String(teamId)}:${String(liveDataset)}:delete`,
    teamId,
    datasetId: liveDataset,
    state: 'deleting',
    stage: 'vector',
    progress: { total: 0, done: 0, failed: 0, skipped: 0 },
    attempt: 0,
    leaseOwner: 'crashed-worker',
    leaseExpireAt: new Date(fixedNow.getTime() - 5 * 3_600_000),
  });
  await operations.create({
    operationId: `delete-vector:${String(teamId)}:${String(liveDataset)}:${String(new mongoose.Types.ObjectId())}:7`,
    teamId,
    resourceRef: {
      resourceType: 'data',
      resourceId: String(new mongoose.Types.ObjectId()),
      version: 7,
    },
    operation: 'delete_vector',
    stage: 'failed',
    attempt: 10,
    nextAttemptAt: fixedNow,
  });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongo.getUri('kb_reconcile'));
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
  jobs = connection.model<DatasetDeleteJobDoc>('DatasetDeleteJob', DatasetDeleteJobSchema);
  operations = connection.model<CrossStoreOperationDoc>(
    'CrossStoreOperation',
    CrossStoreOperationSchema,
  );
  reports = connection.model<ReconcileReportDoc>('ReconcileReport', ReconcileReportSchema);
  connection.model('ImageAsset', ImageAssetSchema);
  await Promise.all([jobs.init(), operations.init(), reports.init(), acls.init()]);
}, 300_000);

beforeEach(async () => {
  await Promise.all([
    datasets.deleteMany({}),
    collections.deleteMany({}),
    datas.deleteMany({}),
    texts.deleteMany({}),
    trainings.deleteMany({}),
    acls.deleteMany({}),
    jobs.deleteMany({}),
    operations.deleteMany({}),
    reports.deleteMany({}),
  ]);
});

afterAll(async () => {
  await connection.close();
  await mongo.stop();
});

describe('对账服务与报告（P6-03 / 设计 14.7 / 16.3）', () => {
  it('窗口严格 [now-6h, now-2h] 且 8 类 finding 各至少一条（ACC-FLOW-003 / ACC-RECON-001 / ACC-DOM-007）', async () => {
    await seedOrphans();
    const liveDataset = await datasets.findOne({ name: 'dataset-live' }).lean();
    const liveCollection = await collections.findOne({ datasetId: liveDataset?._id }).lean();
    const { service, vectors, backfills, queueCalls } = harness({
      vectorRows: [
        {
          teamId: String(teamId),
          datasetId: String(liveDataset?._id),
          collectionId: String(liveCollection?._id),
          dataId: String(new mongoose.Types.ObjectId()),
        },
      ],
      scannerObjects: {
        [`temp/${String(teamId)}/`]: [
          {
            key: `temp/${String(teamId)}/orphan-1`,
            size: 10,
            lastModified: new Date(fixedNow.getTime() - 25 * 3_600_000),
          },
        ],
      },
    });

    const summaries = await service.run(
      { scope: { kind: 'team', teamId: String(teamId) }, mode: 'apply' },
      context,
    );

    expect(summaries).toHaveLength(8);
    for (const summary of summaries) {
      expect(summary.windowStart).toBe(sixHoursBefore.toISOString());
      expect(summary.windowEnd).toBe(twoHoursBefore.toISOString());
      expect(summary.state).toBe('completed');
    }
    const stored = await reports.find({ teamId }).lean();
    expect(stored).toHaveLength(8);
    for (const report of stored) {
      expect(report.windowStart.toISOString()).toBe(sixHoursBefore.toISOString());
      expect(report.windowEnd.toISOString()).toBe(twoHoursBefore.toISOString());
      for (const finding of report.findings) {
        expect(finding.sampleId.length).toBeGreaterThan(0);
        expect(finding.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(finding.action.length).toBeGreaterThan(0);
      }
    }
    const kinds = new Set(stored.flatMap((report) => report.findings.map((f) => f.kind)));
    for (const kind of [
      'vector-orphan',
      'fulltext-orphan',
      's3-orphan',
      'stuck-delete-job',
      'acl-orphan',
      'training-orphan',
      'scheduler-diff',
      'cross-store-failed',
    ]) {
      expect(kinds.has(kind), `缺少 finding kind: ${kind}`).toBe(true);
    }
    const job = await jobs.findOne({ teamId }).lean();
    expect(job?.state).toBe('queued');
    expect(queueCalls.map((call) => call.jobId)).toContain(job?.jobId);
    expect(await acls.countDocuments({ teamId })).toBe(0);
    expect(await trainings.countDocuments({ teamId })).toBe(0);
    expect(backfills).toHaveLength(1);
    expect(String(backfills[0]?.['operationId'])).toMatch(/^s3ttl:.+:backfill$/);
    expect(vectors.deleteCalls).toHaveLength(1);
    expect(vectors.deleteCalls[0]).toMatchObject({
      dataIds: [
        (await reports.findOne({ 'findings.kind': 'vector-orphan' }).lean())?.findings[0]?.sampleId,
      ],
    });
  });

  it('单条失败继续；依赖失败整轮 failed（ACC-OPS-003）', async () => {
    await seedOrphans();
    const dependencyFailure = harness({ vectorThrows: true });
    const failedSummaries = await dependencyFailure.service.run(
      { scope: { kind: 'team', teamId: String(teamId) }, mode: 'apply' },
      context,
    );
    expect(failedSummaries).toHaveLength(8);
    expect(failedSummaries.every((summary) => summary.state === 'failed')).toBe(true);

    await reports.deleteMany({});
    const rowFailure = harness({
      scannerObjects: {
        [`temp/${String(teamId)}/`]: [
          {
            key: `temp/${String(teamId)}/orphan-1`,
            size: 10,
            lastModified: new Date(fixedNow.getTime() - 25 * 3_600_000),
          },
        ],
      },
      backfillThrows: true,
    });
    const summaries = await rowFailure.service.run(
      { scope: { kind: 'team', teamId: String(teamId) }, mode: 'apply' },
      context,
    );
    const s3Summary = summaries.find((summary) => summary.kind === 's3-orphan');
    expect(s3Summary?.state).toBe('pending_review');
    expect(summaries.filter((summary) => summary.state === 'completed')).toHaveLength(7);
  });

  it('同 dedupKey 重复运行幂等且报告不含全文（TEST-RECON-REPEAT-001 / ACC-RECON-002）', async () => {
    const liveDataset = await seedDataset();
    const collection = await seedCollection(liveDataset);
    await seedData(liveDataset, collection, 'SECRET-QA');
    await texts.create({
      teamId,
      datasetId: liveDataset,
      collectionId: collection,
      dataId: new mongoose.Types.ObjectId(),
      fullTextToken: 'SECRET-TOKEN',
    });
    const { service } = harness({ schedulerSummary: null, scannerAbsent: true });

    const first = await service.run(
      { scope: { kind: 'team', teamId: String(teamId) }, mode: 'dry-run' },
      context,
    );
    const second = await service.run(
      { scope: { kind: 'team', teamId: String(teamId) }, mode: 'dry-run' },
      context,
    );
    expect(second.map((summary) => summary.dedupKey)).toEqual(
      first.map((summary) => summary.dedupKey),
    );
    const stored = await reports.find({ teamId }).lean();
    expect(stored).toHaveLength(8);
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain('SECRET-QA');
    expect(serialized).not.toContain('SECRET-TOKEN');
  });

  it('apply 仅清理可证明孤儿，正式引用对象/向量不动', async () => {
    const liveDataset = await seedDataset();
    const collection = await seedCollection(liveDataset);
    const liveData = await seedData(liveDataset, collection);
    await texts.create({
      teamId,
      datasetId: liveDataset,
      collectionId: collection,
      dataId: liveData,
      fullTextToken: 'live-token',
    });
    const orphanText = await texts.create({
      teamId,
      datasetId: liveDataset,
      collectionId: collection,
      dataId: new mongoose.Types.ObjectId(),
      createTime: new Date(fixedNow.getTime() - 3 * 3_600_000),
      fullTextToken: 'orphan-token',
    });
    const orphanTextId = String(orphanText._id);
    await acls.create({
      teamId,
      resourceType: 'dataset',
      resourceId: liveDataset,
      collaboratorType: 'member',
      collaboratorId: new mongoose.Types.ObjectId(),
    });
    await trainings.create({
      teamId,
      datasetId: liveDataset,
      collectionId: collection,
      mode: 'parse',
      expireAt: new Date(fixedNow.getTime() + 86_400_000),
    });
    const { service, vectors } = harness({
      vectorRows: [
        {
          teamId: String(teamId),
          datasetId: String(liveDataset),
          collectionId: String(collection),
          dataId: String(liveData),
        },
      ],
      schedulerSummary: null,
      scannerAbsent: true,
    });

    await service.run({ scope: { kind: 'team', teamId: String(teamId) }, mode: 'apply' }, context);

    expect(vectors.deleteCalls).toHaveLength(0);
    expect(await texts.countDocuments({ dataId: liveData })).toBe(1);
    expect(await texts.countDocuments({ _id: orphanTextId })).toBe(0);
    expect(await acls.countDocuments({ resourceId: liveDataset })).toBe(1);
    expect(await trainings.countDocuments({ datasetId: liveDataset })).toBe(1);
  });

  it('已删除 Dataset 的向量孤儿仍被扫描并清理', async () => {
    const deletedDataset = await seedDataset(true);
    const collection = await seedCollection(deletedDataset);
    const dataId = String(new mongoose.Types.ObjectId());
    const { service, vectors } = harness({
      vectorRows: [
        {
          teamId: String(teamId),
          datasetId: String(deletedDataset),
          collectionId: String(collection),
          dataId,
        },
      ],
      schedulerSummary: null,
      scannerAbsent: true,
    });

    const summaries = await service.run(
      { scope: { kind: 'team', teamId: String(teamId) }, mode: 'apply' },
      context,
    );
    expect(summaries.find((summary) => summary.kind === 'vector-orphan')?.counts.success).toBe(1);
    expect(vectors.deleteCalls).toEqual([
      {
        datasetId: String(deletedDataset),
        dataIds: [dataId],
        options: { timeoutMs: 30_000 },
      },
    ]);
  });

  it('listReports：非 Root 强制 teamId，Root 使用显式 scope（ACC-OPS-007）', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const service = new ReconcileApplicationService({
      facts: new MongoDeleteFactsRepository(connection),
      reports: {
        start: async () => undefined,
        finish: async () => true,
        listReports: async (input) => {
          captured.push(input as unknown as Record<string, unknown>);
          return { total: 0, list: [] };
        },
      },
      vectorController: new FakeVectors({}) as unknown as VectorController,
    });
    await service.listReports(
      { windowHours: 6, scope: { datasetIds: [String(new mongoose.Types.ObjectId())] }, page: 1 },
      context,
    );
    expect(captured[0]?.['teamIds']).toEqual([String(teamId)]);

    const rootContext: RequestContext = {
      ...context,
      tenant: { ...context.tenant, isRoot: true },
    };
    await service.listReports(
      { windowHours: 6, scope: { teamIds: [String(teamId)] }, page: 1 },
      rootContext,
    );
    expect(captured[1]?.['teamIds']).toBeNull();
  });

  it('ROOT-004 路由返回 200 且非 501999，teamId 透传（ACC-OPS-007）', async () => {
    const calls: Array<{ windowHours: number; teamId: string }> = [];
    routeFixture.runtime = {
      adminAuthProvider: {
        resolve: async () => ({
          teamId: routeFixture.teamId,
          tmbId: 'tmb-route',
          authType: 'root',
          isRoot: true,
          sourceName: 'reconcile-route-test',
        }),
      },
      reconcileService: {
        listReports: async (
          input: { windowHours: number },
          ctx: RequestContext,
        ): Promise<{ total: number; list: unknown[] }> => {
          calls.push({ windowHours: input.windowHours, teamId: ctx.tenant.teamId });
          return { total: 1, list: [{ dedupKey: 'dedup-1', scope: {}, state: 'completed' }] };
        },
      },
    };
    const request = {
      method: 'GET',
      url: `/api/admin/dataset/reconcile/reports?window=6h&scope=${encodeURIComponent(
        JSON.stringify({ teamIds: [routeFixture.teamId] }),
      )}&page=1`,
      query: {
        window: '6h',
        scope: JSON.stringify({ teamIds: [routeFixture.teamId] }),
        page: '1',
      },
      body: {},
      headers: {},
    } as unknown as NextApiRequest;
    let status = 200;
    let body: unknown;
    const response = {
      setHeader: () => response,
      status(code: number) {
        status = code;
        return response;
      },
      json(value: unknown) {
        body = value;
        return response;
      },
    } as unknown as NextApiResponse;

    await reconcileReportsRoute(request, response);

    expect(status).toBe(200);
    const envelope = body as { code: number; data: { total: number } };
    expect(envelope.code).toBe(200);
    expect(envelope.data.total).toBe(1);
    expect(calls).toEqual([{ windowHours: 6, teamId: routeFixture.teamId }]);
  });
});
