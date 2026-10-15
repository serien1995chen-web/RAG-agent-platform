import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuditPort, AuditRecord, BackupToolPort, MongoIndexManagerPort } from '../../src';
import type { RequestContext } from '../../src/ports/types';
import {
  MigrationExecutionRegistry,
  createMigrationRunAdapter,
} from '../../src/modules/migration/adapter';
import {
  MigrationExecutor,
  type MigrationDefinition,
} from '../../src/modules/migration/application';
import {
  DatasetMigrationLogSchema,
  DatasetMigrationSchema,
  type DatasetMigrationDoc,
  type DatasetMigrationLogDoc,
} from '../../src/shared/persistence/schemas';

const teamId = new mongoose.Types.ObjectId();
const context: RequestContext = {
  requestId: 'req-migration-executor',
  tenant: {
    teamId: String(teamId),
    tmbId: String(new mongoose.Types.ObjectId()),
    authType: 'root',
    isRoot: true,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const scope = { teamIds: [String(teamId)], operationTypes: ['migrate'] };

let mongo: MongoMemoryServer;
let connection: mongoose.Connection;
let migrations: mongoose.Model<DatasetMigrationDoc>;
let logs: mongoose.Model<DatasetMigrationLogDoc>;

function definition(overrides: Partial<MigrationDefinition> = {}): MigrationDefinition {
  return {
    version: 'test-migration-v1',
    name: 'test migration',
    batches: [
      {
        id: 'batch-1',
        nextCursor: 'cursor-1',
        execute: async () => ({
          counts: { expected: 2, actual: 2 },
          references: { checked: 2, missing: [] },
          operation: { action: 'first' },
        }),
      },
      {
        id: 'batch-2',
        nextCursor: 'cursor-2',
        execute: async () => ({
          counts: { expected: 1, actual: 1 },
          references: { checked: 1, missing: [] },
          operation: { action: 'second' },
        }),
      },
    ],
    writeMode: 'readonly',
    estimatedWindow: { minMs: 10, maxMs: 20 },
    rollbackWindow: { minMs: 5, maxMs: 10 },
    backupRequired: false,
    ...overrides,
  };
}

function backupTool(verified = true): BackupToolPort {
  return {
    validate: async () => ({ valid: true }),
    run: async () => ({ evidence: { mode: 'mock', checksum: 'sha256:test' } }),
    verify: async () => ({ verified }),
  };
}

function indexManager(errors: string[] = []): MongoIndexManagerPort & { cleanupCalls: number } {
  return {
    cleanupCalls: 0,
    inspect: async () => ({
      created: [],
      dropped: [],
      skipped: ['unregistered:customer_index'],
      errors,
    }),
    sync: async () => ({ created: [], dropped: [], skipped: [], errors }),
    async cleanup() {
      this.cleanupCalls += 1;
      return { dropped: [], skipped: [] };
    },
  };
}

function auditPort(records: AuditRecord[]): AuditPort {
  return {
    append: async (record) => {
      records.push(record);
      return { auditId: String(records.length) };
    },
  };
}

async function expectApiError(promise: Promise<unknown>, code: number): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ error: { code } });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = mongoose.createConnection(mongo.getUri('kb_migration_executor'));
  await connection.asPromise();
  migrations = connection.model<DatasetMigrationDoc>('DatasetMigration', DatasetMigrationSchema);
  logs = connection.model<DatasetMigrationLogDoc>('DatasetMigrationLog', DatasetMigrationLogSchema);
  await Promise.all([migrations.init(), logs.init()]);
}, 300_000);

beforeEach(async () => {
  await Promise.all([migrations.deleteMany({}), logs.deleteMany({})]);
});

afterAll(async () => {
  await connection.close();
  await mongo.stop();
});

describe('MigrationExecutor (P7-04)', () => {
  it('dry-run does not write business or registry data (TEST-MIG-DRY-001, ACC-MIG-001)', async () => {
    const executor = new MigrationExecutor({
      registry: createMigrationRunAdapter({ connection }),
      backupTool: backupTool(),
      mongoIndexManager: indexManager(),
      definitions: [definition()],
    });

    const result = await executor.dryRun(
      { version: 'test-migration-v1', scope, options: { timeoutMs: 5_000 } },
      context,
    );

    expect(result.state).toBe('dry_run');
    expect(await migrations.countDocuments({})).toBe(0);
    expect(await logs.countDocuments({})).toBe(0);
  });

  it('normalizes contract ScopeSelector and enforces root/non-root tenant semantics', async () => {
    const executor = new MigrationExecutor({
      registry: createMigrationRunAdapter({ connection }),
      backupTool: backupTool(),
      mongoIndexManager: indexManager(),
      definitions: [definition()],
    });
    const normalized = await executor.dryRun(
      {
        version: 'test-migration-v1',
        scope: {
          teamIds: [String(teamId), String(teamId).toUpperCase()],
          operationTypes: ['migrate', 'migrate'],
        },
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(normalized.state).toBe('dry_run');

    await expectApiError(
      executor.dryRun(
        {
          version: 'test-migration-v1',
          scope: { teamIds: [String(teamId)], kind: 'all' },
          options: { timeoutMs: 5_000 },
        },
        context,
      ),
      501025,
    );

    const nonRootContext: RequestContext = {
      ...context,
      tenant: {
        ...context.tenant,
        authType: 'token',
        isRoot: false,
      },
    };
    await expectApiError(
      executor.dryRun(
        {
          version: 'test-migration-v1',
          scope: { teamIds: [String(new mongoose.Types.ObjectId())] },
          options: { timeoutMs: 5_000 },
        },
        nonRootContext,
      ),
      501070,
    );
  });

  it('apply is idempotent for the same key and rejects concurrent scope runs (TEST-REP-MIG-001, ACC-MIG-002)', async () => {
    let executions = 0;
    const executor = new MigrationExecutor({
      registry: createMigrationRunAdapter({ connection }),
      backupTool: backupTool(),
      mongoIndexManager: indexManager(),
      definitions: [
        definition({
          batches: [
            {
              id: 'batch-1',
              nextCursor: 'cursor-1',
              execute: async () => {
                executions += 1;
                return {
                  counts: { expected: 1, actual: 1 },
                  references: { checked: 1, missing: [] },
                };
              },
            },
          ],
        }),
      ],
    });

    const first = await executor.apply(
      {
        version: 'test-migration-v1',
        scope,
        idempotencyKey: 'idem-1',
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    const replay = await executor.apply(
      {
        version: 'test-migration-v1',
        scope,
        idempotencyKey: 'idem-1',
        options: { timeoutMs: 5_000 },
      },
      context,
    );

    expect(first.runId).toBe(replay.runId);
    expect(executions).toBe(1);
    await expectApiError(
      executor.apply(
        {
          version: 'test-migration-v1',
          scope,
          idempotencyKey: 'idem-2',
          options: { timeoutMs: 5_000 },
        },
        context,
      ),
      501024,
    );
  });

  it('resume takes over stale runs, advances the cursor, and rejects cursor rollback (TEST-MIG-RESUME-001, ACC-MIG-003)', async () => {
    let executions = 0;
    const executor = new MigrationExecutor({
      registry: createMigrationRunAdapter({ connection }),
      backupTool: backupTool(),
      mongoIndexManager: indexManager(),
      definitions: [
        definition({
          batches: [
            {
              id: 'batch-1',
              nextCursor: 'cursor-1',
              execute: async () => {
                executions += 1;
                throw new Error('intentional first-batch failure');
              },
            },
            {
              id: 'batch-2',
              nextCursor: 'cursor-2',
              execute: async () => {
                executions += 1;
                return {
                  counts: { expected: 1, actual: 1 },
                  references: { checked: 1, missing: [] },
                };
              },
            },
          ],
        }),
      ],
    });

    const failed = await executor.apply(
      {
        version: 'test-migration-v1',
        scope,
        idempotencyKey: 'idem-3',
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(failed.state).toBe('failed');

    await migrations.updateOne(
      { _id: new mongoose.Types.ObjectId(failed.runId) },
      { $set: { state: 'running', updateTime: new Date(Date.now() - 120_000) } },
    );
    const resumed = await executor.resume(
      {
        runId: failed.runId,
        cursor: 'cursor-1',
        idempotencyKey: 'idem-4',
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    expect(resumed.state).toBe('done');
    expect(resumed.cursor).toBe('cursor-2');
    expect(executions).toBe(2);
    await expectApiError(
      executor.resume(
        {
          runId: failed.runId,
          cursor: 'cursor-1',
          idempotencyKey: 'idem-5',
          options: { timeoutMs: 5_000 },
        },
        context,
      ),
      501025,
    );
  });

  it('rollback preserves evidence and is repeat-safe (TEST-MIG-ROLLBACK-001, ACC-MIG-007)', async () => {
    const executor = new MigrationExecutor({
      registry: createMigrationRunAdapter({ connection }),
      backupTool: backupTool(),
      mongoIndexManager: indexManager(),
      definitions: [
        definition({
          version: 'test-rollback-v1',
          batches: [
            {
              id: 'batch-1',
              nextCursor: 'cursor-1',
              execute: async () => {
                throw new Error('force rollback');
              },
            },
          ],
        }),
      ],
    });

    const failed = await executor.apply(
      {
        version: 'test-rollback-v1',
        scope,
        idempotencyKey: 'idem-rollback',
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    const first = await executor.rollback(
      { runId: failed.runId, options: { timeoutMs: 5_000 } },
      context,
    );
    const second = await executor.rollback(
      { runId: failed.runId, options: { timeoutMs: 5_000 } },
      context,
    );

    expect(first.state).toBe('rolled_back');
    expect(second.state).toBe('rolled_back');
    const doc = await migrations.findById(failed.runId).lean();
    expect(doc?.state).toBe('cancelled');
    expect(doc?.rollbackInfo).toMatchObject({ changeId: expect.any(String) });
  });

  it('keeps unknown indexes and never calls cleanup (ACC-MIG-004/005)', async () => {
    const indexes = indexManager();
    const executor = new MigrationExecutor({
      registry: createMigrationRunAdapter({ connection }),
      backupTool: backupTool(),
      mongoIndexManager: indexes,
      definitions: [definition({ version: 'test-index-v1', batches: [] })],
    });

    const result = await executor.apply(
      {
        version: 'test-index-v1',
        scope,
        idempotencyKey: 'idem-index',
        options: { timeoutMs: 5_000 },
      },
      context,
    );

    expect(result.state).toBe('done');
    expect(indexes.cleanupCalls).toBe(0);
  });

  it('blocks completion when backup verification or counts fail (ACC-MIG-006/008)', async () => {
    const auditRecords: AuditRecord[] = [];
    const executor = new MigrationExecutor({
      registry: new MigrationExecutionRegistry(connection),
      backupTool: backupTool(false),
      mongoIndexManager: indexManager(),
      audit: auditPort(auditRecords),
      definitions: [definition({ version: 'test-backup-v1', backupRequired: true })],
    });

    await expectApiError(
      executor.apply(
        {
          version: 'test-backup-v1',
          scope,
          idempotencyKey: 'idem-backup',
          options: { timeoutMs: 5_000 },
        },
        context,
      ),
      501025,
    );
    expect(await migrations.countDocuments({ version: 'test-backup-v1' })).toBe(0);
    expect(auditRecords).toHaveLength(0);
  });
});
