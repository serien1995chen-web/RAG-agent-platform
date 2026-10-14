import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiErrorException } from '../../src/index';
import type { RequestContext } from '../../src/ports/types';
import { ArchiveStatusAdapter } from '../../src/shared/runtime/archive-status.adapter';
import { FailureQueryAdapter } from '../../src/shared/runtime/failure-query.adapter';
import {
  DatasetDeleteFailureSchema,
  DatasetMigrationLogSchema,
  DatasetTrainingSchema,
  OperationLogSchema,
  type DatasetDeleteFailureDoc,
  type DatasetMigrationLogDoc,
  type DatasetTrainingDoc,
  type OperationLogDoc,
} from '../../src/shared/persistence/schemas';

const teamId = new mongoose.Types.ObjectId();
const otherTeamId = new mongoose.Types.ObjectId();
const tmbId = new mongoose.Types.ObjectId();

const context: RequestContext = {
  requestId: 'req-admin-ports',
  tenant: { teamId: String(teamId), tmbId: String(tmbId), authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const t0 = new Date('2026-01-01T00:00:00.000Z');
const t1 = new Date('2026-01-02T00:00:00.000Z');
const t2 = new Date('2026-01-03T00:00:00.000Z');
const t3 = new Date('2026-01-04T00:00:00.000Z');

let replSet: MongoMemoryReplSet;
let connection: mongoose.Connection;
let deleteFailures: mongoose.Model<DatasetDeleteFailureDoc>;
let trainings: mongoose.Model<DatasetTrainingDoc>;
let migrationLogs: mongoose.Model<DatasetMigrationLogDoc>;
let operationLogs: mongoose.Model<OperationLogDoc>;
let archive: ArchiveStatusAdapter;
let failures: FailureQueryAdapter;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  connection = mongoose.createConnection(replSet.getUri('kb_admin_ports'));
  await connection.asPromise();
  deleteFailures = connection.model<DatasetDeleteFailureDoc>(
    'DatasetDeleteFailure',
    DatasetDeleteFailureSchema,
  );
  trainings = connection.model<DatasetTrainingDoc>('DatasetTraining', DatasetTrainingSchema);
  migrationLogs = connection.model<DatasetMigrationLogDoc>(
    'DatasetMigrationLog',
    DatasetMigrationLogSchema,
  );
  operationLogs = connection.model<OperationLogDoc>('OperationLog', OperationLogSchema);
  await Promise.all([
    deleteFailures.init(),
    trainings.init(),
    migrationLogs.init(),
    operationLogs.init(),
  ]);
  archive = new ArchiveStatusAdapter();
  failures = new FailureQueryAdapter({ connection });
}, 300_000);

beforeEach(async () => {
  await Promise.all([
    deleteFailures.deleteMany({}),
    trainings.deleteMany({}),
    migrationLogs.deleteMany({}),
    operationLogs.deleteMany({}),
  ]);
});

afterAll(async () => {
  await connection.close();
  await replSet.stop();
});

async function seed(): Promise<void> {
  await deleteFailures.create({
    teamId,
    jobId: 'job-1',
    resourceType: 'data',
    resourceId: 'r-del',
    stage: 'delete',
    attempt: 1,
    errorClass: 'storage',
    retryable: true,
    lastError: 'boom',
    createTime: t0,
    updateTime: t0,
  });
  await trainings.create({
    teamId,
    datasetId: new mongoose.Types.ObjectId(),
    collectionId: new mongoose.Types.ObjectId(),
    dataId: 'r-train',
    mode: 'parse',
    retryCount: 3,
    lockTime: t0,
    errorMsg: 'train boom',
    weight: 0,
    expireAt: new Date('2030-01-01T00:00:00.000Z'),
    billId: null,
    payload: {},
    imageDescMap: null,
    indexes: [],
    createTime: t1,
    updateTime: t1,
  });
  await migrationLogs.create({
    migrationId: 'mig-1',
    version: 'v1',
    batchId: 'batch-1',
    teamId,
    resourceRef: { resourceType: 'dataset', resourceId: 'r-mig', version: 1 },
    dataId: null,
    state: 'failed',
    attempts: 1,
    operations: null,
    error: { message: 'mig boom' },
    rollbackInfo: null,
    createTime: t2,
    updateTime: t2,
  });
  await operationLogs.create({
    teamId,
    tmbId,
    timestamp: t3,
    event: 'permission.changed',
    metadata: {},
    requestId: 'req-1',
    operation: 'permission.changed',
    resourceType: 'dataset',
    resourceId: 'r-audit',
    result: 'failed',
    beforeHash: null,
    afterHash: null,
    params: null,
  });
}

async function expectApiError(promise: Promise<unknown>, code: number): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiErrorException);
  expect((caught as ApiErrorException).error.code).toBe(code);
}

describe('archive status and failure query ports (P7-08 / TEST-PORT-CONTRACT-001)', () => {
  it('returns archived_not_supported and rejects an invalid dataset id', async () => {
    const result = await archive.status(
      { datasetId: String(new mongoose.Types.ObjectId()), options: { timeoutMs: 5_000 } },
      context,
    );
    expect(result).toEqual({ archived: false, state: 'archived_not_supported' });
    await expectApiError(
      archive.status({ datasetId: 'bad-id', options: { timeoutMs: 5_000 } }, context),
      501070,
    );
  });

  it('merges the four sources in time-descending order', async () => {
    await seed();
    const page = await failures.query(
      { scope: {}, limit: 10, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(page.total).toBe(4);
    expect(page.list.map((record) => record.resourceType)).toEqual([
      'dataset',
      'migration',
      'training',
      'data',
    ]);
    expect(page.list[0]?.reason).toBe('permission.changed');
    expect(page.list[1]?.reason).toBe('mig boom');
  });

  it('filters by normalized resourceType', async () => {
    await seed();
    const page = await failures.query(
      { scope: { resourceType: 'training' }, limit: 10, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(page.list).toEqual([
      { resourceType: 'training', resourceId: 'r-train', reason: 'train boom', retryable: true },
    ]);
  });

  it('filters by a closed from/to time interval', async () => {
    await seed();
    const page = await failures.query(
      {
        scope: { from: t1.toISOString(), to: t2.toISOString() },
        limit: 10,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(page.list.map((record) => record.resourceId).sort()).toEqual(['r-mig', 'r-train']);
  });

  it('filters by normalized errorClass', async () => {
    await seed();
    const page = await failures.query(
      { scope: { errorClass: 'storage' }, limit: 10, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(page.list).toEqual([
      { resourceType: 'data', resourceId: 'r-del', reason: 'boom', retryable: true },
    ]);
  });

  it('paginates with an opaque cursor and no overlap', async () => {
    await seed();
    const first = await failures.query(
      { scope: {}, limit: 2, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(first.list).toHaveLength(2);
    expect(first.cursor).not.toBeNull();
    expect(first.total).toBe(4);

    const second = await failures.query(
      { scope: {}, cursor: first.cursor ?? undefined, limit: 2, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(second.list).toHaveLength(2);
    expect(second.total).toBe(4);
    const firstIds = first.list.map((record) => record.resourceId);
    const secondIds = second.list.map((record) => record.resourceId);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it('enforces strict tenant scope', async () => {
    await seed();
    await expectApiError(
      failures.query(
        { scope: { teamId: String(otherTeamId) }, limit: 10, options: { timeoutMs: 5_000 } },
        context,
      ),
      501070,
    );

    const root: RequestContext = { ...context, tenant: { ...context.tenant, isRoot: true } };
    await expectApiError(
      failures.query({ scope: {}, limit: 10, options: { timeoutMs: 5_000 } }, root),
      501070,
    );
    const readable = await failures.query(
      { scope: { teamId: String(teamId) }, limit: 10, options: { timeoutMs: 5_000 } },
      root,
    );
    expect(readable.total).toBe(4);

    await expectApiError(
      failures.query(
        { scope: {}, cursor: 'not-a-cursor', limit: 10, options: { timeoutMs: 5_000 } },
        context,
      ),
      501070,
    );
  });

  it('stays read-only across the four sources', async () => {
    await seed();
    const before = await Promise.all([
      deleteFailures.countDocuments({}),
      trainings.countDocuments({}),
      migrationLogs.countDocuments({}),
      operationLogs.countDocuments({}),
    ]);
    await failures.query({ scope: {}, limit: 10, options: { timeoutMs: 5_000 } }, context);
    const after = await Promise.all([
      deleteFailures.countDocuments({}),
      trainings.countDocuments({}),
      migrationLogs.countDocuments({}),
      operationLogs.countDocuments({}),
    ]);
    expect(after).toEqual(before);
  });
});
