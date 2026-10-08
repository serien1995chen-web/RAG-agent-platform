import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestContext } from '../../src/ports/types';
import { MongoMigrationRepository } from '../../src/modules/migration/repository/mongo-migration.repository';
import {
  DatasetMigrationLogSchema,
  DatasetMigrationSchema,
  type DatasetMigrationDoc,
  type DatasetMigrationLogDoc,
} from '../../src/shared/persistence/schemas';

const teamId = new mongoose.Types.ObjectId();
const context: RequestContext = {
  requestId: 'req-migration-repo',
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
let repository: MongoMigrationRepository;
let migrations: mongoose.Model<DatasetMigrationDoc>;
let logs: mongoose.Model<DatasetMigrationLogDoc>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongo.getUri('kb_migration_repository'));
  await connection.asPromise();
  migrations = connection.model<DatasetMigrationDoc>('DatasetMigration', DatasetMigrationSchema);
  logs = connection.model<DatasetMigrationLogDoc>('DatasetMigrationLog', DatasetMigrationLogSchema);
  await Promise.all([migrations.init(), logs.init()]);
  repository = new MongoMigrationRepository(connection);
}, 60_000);

beforeEach(async () => {
  await Promise.all([migrations.deleteMany({}), logs.deleteMany({})]);
});

afterAll(async () => {
  await connection.close();
  await mongo.stop();
});

describe('MongoMigrationRepository (P2-13)', () => {
  it('enforces version uniqueness and one running scope', async () => {
    const scope = { teamId: String(teamId), kind: 'all' };
    await repository.apply(
      { version: 'v1', scope, idempotencyKey: 'id-1', options: { timeoutMs: 5_000 } },
      context,
    );
    await expect(
      repository.apply(
        { version: 'v1', scope, idempotencyKey: 'id-2', options: { timeoutMs: 5_000 } },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501005 } });
    await expect(
      repository.apply(
        { version: 'v2', scope, idempotencyKey: 'id-3', options: { timeoutMs: 5_000 } },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501005 } });
  });

  it('advances resumeToken monotonically and writes idempotent logs', async () => {
    const scope = { teamId: String(teamId), kind: 'all' };
    const applied = await repository.apply(
      { version: 'v3', scope, idempotencyKey: 'id-4', options: { timeoutMs: 5_000 } },
      context,
    );
    const resumed = await repository.resume(
      {
        runId: applied.runId,
        cursor: 'cursor-2',
        idempotencyKey: 'id-5',
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(resumed.cursor).toBe('cursor-2');
    await expect(
      repository.resume(
        {
          runId: applied.runId,
          cursor: 'cursor-1',
          idempotencyKey: 'id-6',
          options: { timeoutMs: 5_000 },
        },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501005 } });

    const log = {
      migrationId: applied.runId,
      version: 'v3',
      batchId: 'batch-1',
      resourceRef: { resourceType: 'dataset', resourceId: 'dataset-1', version: 1 },
      dataId: 'data-1',
      state: 'done',
    };
    await repository.writeLog(log, context);
    await repository.writeLog(log, context);
    expect(
      await repository.listLogs(
        { migrationId: applied.runId, options: { timeoutMs: 5_000 } },
        context,
      ),
    ).toHaveLength(1);
  });
});
