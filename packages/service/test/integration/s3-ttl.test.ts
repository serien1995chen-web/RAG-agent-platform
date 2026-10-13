import { ApiErrorException, createApiError } from '@kb/contracts';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ObjectStorePort } from '../../src/ports/capabilities';
import type { RequestContext } from '../../src/ports/types';
import {
  S3TtlService,
  type OrphanObjectLister,
} from '../../src/modules/delete/application/s3-ttl.service';
import type { S3ObjectDescriptor } from '../../src/modules/delete/domain/findings';
import { MongoS3TtlRepository } from '../../src/modules/delete/repository/mongo-s3-ttl.repository';
import {
  DatasetDataSchema,
  DatasetSchema,
  ImageAssetSchema,
  S3TtlRecordSchema,
  type DatasetDataDoc,
  type DatasetDoc,
  type ImageAssetDoc,
  type S3TtlRecordDoc,
} from '../../src/shared/persistence/schemas';

const teamId = new mongoose.Types.ObjectId();
const otherTeamId = new mongoose.Types.ObjectId();

const context: RequestContext = {
  requestId: 'req-s3-ttl',
  tenant: {
    teamId: String(teamId),
    tmbId: String(new mongoose.Types.ObjectId()),
    authType: 'internal',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
};

const fixedNow = new Date('2026-10-14T12:00:00.000Z');
const sevenDaysAgo = new Date(fixedNow.getTime() - 7 * 24 * 3_600_000);

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let ttlRecords: mongoose.Model<S3TtlRecordDoc>;
let imageAssets: mongoose.Model<ImageAssetDoc>;
let datas: mongoose.Model<DatasetDataDoc>;
let datasets: mongoose.Model<DatasetDoc>;

interface FakeStoreState {
  aborts: string[];
  deletes: string[];
  deleteError?: Error;
}

function fakeObjectStore(state: FakeStoreState): ObjectStorePort {
  return {
    async abort(input: { ref: { key: string } }): Promise<{ aborted: boolean }> {
      state.aborts.push(input.ref.key);
      return { aborted: true };
    },
    async delete(input: { ref: { key: string } }): Promise<{ deleted: boolean }> {
      state.deletes.push(input.ref.key);
      if (state.deleteError) throw state.deleteError;
      return { deleted: true };
    },
  } as unknown as ObjectStorePort;
}

function serviceOf(options: {
  storeState: FakeStoreState;
  lister?: OrphanObjectLister;
  loggerEvents?: string[];
}): { service: S3TtlService; repository: MongoS3TtlRepository } {
  const repository = new MongoS3TtlRepository(connection);
  const service = new S3TtlService({
    repository,
    objectStore: fakeObjectStore(options.storeState),
    clock: () => fixedNow,
    logger: {
      log: (event) => {
        options.loggerEvents?.push(event);
      },
    },
    ...(options.lister !== undefined ? { orphanObjectLister: options.lister } : {}),
  });
  return { service, repository };
}

async function seedTtl(overrides: Partial<S3TtlRecordDoc> = {}): Promise<mongoose.Types.ObjectId> {
  const doc = await ttlRecords.create({
    teamId,
    bucketName: 'kb-local',
    objectKey: `temp/${String(teamId)}/a.txt`,
    expireAt: sevenDaysAgo,
    state: 'pending',
    attempt: 0,
    nextAttemptAt: new Date(fixedNow.getTime() - 3_600_000),
    resourceRef: { resourceType: 'file', resourceId: 'a', version: 1 },
    operationId: `s3ttl:${String(teamId)}:op-${String(new mongoose.Types.ObjectId())}:register`,
    ...overrides,
  });
  return doc._id;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongo.getUri('kb_s3_ttl'));
  await connection.asPromise();
  ttlRecords = connection.model<S3TtlRecordDoc>('S3TtlRecord', S3TtlRecordSchema);
  imageAssets = connection.model<ImageAssetDoc>('ImageAsset', ImageAssetSchema);
  datas = connection.model<DatasetDataDoc>('DatasetData', DatasetDataSchema);
  datasets = connection.model<DatasetDoc>('Dataset', DatasetSchema);
  await Promise.all([ttlRecords.init(), imageAssets.init()]);
}, 300_000);

beforeEach(async () => {
  await Promise.all([
    ttlRecords.deleteMany({}),
    imageAssets.deleteMany({}),
    datas.deleteMany({}),
    datasets.deleteMany({}),
  ]);
});

afterAll(async () => {
  await connection.close();
  await mongo.stop();
});

describe('S3 TTL 清理（P6-04 / 设计 10.9.1）', () => {
  it('expireAt 晚于 now-5min 不领取（TEST-TTL-SKEW-001）', async () => {
    await seedTtl({ expireAt: new Date(fixedNow.getTime() - 2 * 60 * 1000) });
    const state: FakeStoreState = { aborts: [], deletes: [] };
    const { service } = serviceOf({ storeState: state });
    const stats = await service.sweepOnce(context);
    expect(stats.scanned).toBe(0);
    const record = await ttlRecords.findOne({ teamId }).lean();
    expect(record?.state).toBe('pending');
    expect(state.deletes).toHaveLength(0);
  });

  it('约 7 天到期记录删除对象并删记录（TEST-TTL-001）', async () => {
    await seedTtl();
    const state: FakeStoreState = { aborts: [], deletes: [] };
    const { service } = serviceOf({ storeState: state });
    const stats = await service.sweepOnce(context);
    expect(stats).toEqual({ scanned: 1, deleted: 1, failed: 0, skipped: 0 });
    expect(state.aborts).toEqual([`temp/${String(teamId)}/a.txt`]);
    expect(state.deletes).toEqual([`temp/${String(teamId)}/a.txt`]);
    expect(await ttlRecords.countDocuments({ teamId })).toBe(0);
  });

  it('promote 后仅删 TTL 记录、对象保留（TEST-TTL-PROMOTE-001）', async () => {
    const objectKey = `image/${String(teamId)}/img-1.png`;
    await seedTtl({ objectKey });
    await imageAssets.create({
      imageId: 'img-1',
      teamId,
      datasetId: new mongoose.Types.ObjectId(),
      objectKey,
      mimeType: 'image/png',
      size: 10,
      persistent: true,
      state: 'referenced',
    });
    const state: FakeStoreState = { aborts: [], deletes: [] };
    const { service } = serviceOf({ storeState: state });
    const stats = await service.sweepOnce(context);
    expect(stats.deleted).toBe(1);
    expect(state.deletes).toHaveLength(0);
    expect(state.aborts).toHaveLength(0);
    expect(await ttlRecords.countDocuments({ teamId })).toBe(0);
  });

  it('删除失败 attempt+1 且指数退避；第 10 次后保持 failed（TEST-TTL-FAIL-001）', async () => {
    const recordId = await seedTtl();
    const state: FakeStoreState = {
      aborts: [],
      deletes: [],
      deleteError: new Error('delete-failed'),
    };
    const { service } = serviceOf({ storeState: state });
    const stats = await service.sweepOnce(context);
    expect(stats.failed).toBe(1);
    const afterFirst = await ttlRecords.findById(recordId).lean();
    expect(afterFirst?.state).toBe('failed');
    expect(afterFirst?.attempt).toBe(1);
    expect(afterFirst?.nextAttemptAt.getTime()).toBe(fixedNow.getTime() + 60_000);

    await ttlRecords.updateOne(
      { _id: recordId },
      {
        $set: {
          attempt: 9,
          nextAttemptAt: new Date(fixedNow.getTime() - 60_000),
          state: 'pending',
          expireAt: sevenDaysAgo,
        },
      },
    );
    await service.sweepOnce(context);
    const exhausted = await ttlRecords.findById(recordId).lean();
    expect(exhausted?.state).toBe('failed');
    expect(exhausted?.attempt).toBe(10);
    expect(exhausted?.nextAttemptAt.getTime()).toBe(fixedNow.getTime() + 3_600_000);

    const finalStats = await service.sweepOnce(context);
    expect(finalStats.scanned).toBe(0);
  });

  it('跨租户 key 拒绝、写安全审计且无删除（TEST-TTL-TENANT-001）', async () => {
    await seedTtl({ objectKey: `temp/${String(otherTeamId)}/steal.txt` });
    const state: FakeStoreState = { aborts: [], deletes: [] };
    const loggerEvents: string[] = [];
    const { service } = serviceOf({ storeState: state, loggerEvents });
    const stats = await service.sweepOnce(context);
    expect(stats.skipped).toBe(1);
    expect(loggerEvents).toContain('s3-ttl.tenant_rejected');
    expect(state.deletes).toHaveLength(0);
    const record = await ttlRecords.findOne({ teamId }).lean();
    expect(record).not.toBeNull();
    expect(record?.attempt).toBe(0);
  });

  it('注册/补写按 operationId 幂等重试（TEST-TTL-REG-FAIL-001）', async () => {
    const task = serviceOf({ storeState: { aborts: [], deletes: [] } });
    const operationId = `s3ttl:${String(teamId)}:reg-op:backfill`;
    const input = {
      teamId: String(teamId),
      bucketName: 'kb-local',
      objectKey: `temp/${String(teamId)}/reg.txt`,
      expireAt: new Date(fixedNow.getTime() + 7 * 24 * 3_600_000),
      operationId,
      resourceRef: { resourceType: 'object', resourceId: 'reg', version: 0 },
    };
    await task.repository.backfill(input);
    await task.repository.backfill(input);
    expect(await ttlRecords.countDocuments({ teamId })).toBe(1);
  });

  it('宽限期 24h 内不补写；超期补写 pending；无法归属转 pending_review（TEST-TTL-ORPHAN-001）', async () => {
    const objects: S3ObjectDescriptor[] = [
      {
        key: `temp/${String(teamId)}/fresh.txt`,
        size: 1,
        lastModified: new Date(fixedNow.getTime() - 2 * 3_600_000),
      },
      {
        key: `temp/${String(teamId)}/old.txt`,
        size: 1,
        lastModified: new Date(fixedNow.getTime() - 25 * 3_600_000),
      },
      {
        key: `dataset/${String(new mongoose.Types.ObjectId())}/missing.txt`,
        size: 1,
        lastModified: new Date(fixedNow.getTime() - 48 * 3_600_000),
      },
    ];
    const lister: OrphanObjectLister = {
      listByPrefix: async ({ prefix }): Promise<S3ObjectDescriptor[]> =>
        objects.filter((object) => object.key.startsWith(prefix)),
    };
    const { service } = serviceOf({
      storeState: { aborts: [], deletes: [] },
      lister,
    });
    const scan = await service.scanOrphans({ now: fixedNow });
    expect(scan.backfilled).toBe(1);
    expect(scan.pendingReview).toBe(1);
    const records = await ttlRecords.find({ teamId }).lean();
    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe('pending');
    expect(records[0]?.objectKey).toBe(`temp/${String(teamId)}/old.txt`);
    expect(records[0]?.expireAt.getTime()).toBe(fixedNow.getTime() + 7 * 24 * 3_600_000);
  });
});
