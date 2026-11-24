import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  B19_B_RUN_ID,
  b19bTenantContext,
  mongoUriForRun,
  writeB19BEvidence,
} from '../../../../test/fixtures/b19-b/support';
import { S10StatusProbesAdapter } from '../../src/modules/knowledge/adapter/s10-status-probes.adapter';
import { S10ConnectorSchedulerApplication } from '../../src/modules/knowledge/application/s10-connector-scheduler.application';
import { KnowledgeCatalogRepository } from '../../src/modules/knowledge/repository/catalog.repository';
import { KnowledgeConnectorRepository } from '../../src/modules/knowledge/repository/connector.repository';
import { KnowledgeConnectorScheduleRepository } from '../../src/modules/knowledge/repository/connector-scheduler.repository';
import { KnowledgeCredentialCipher } from '../../src/modules/knowledge/adapter/credential-cipher';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';

const root = resolve(import.meta.dirname, '../../../..');
const context = b19bTenantContext('status-scheduler');
let connection: mongoose.Connection;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

beforeAll(async () => {
  connection = mongoose.createConnection(mongoUriForRun(requiredEnv('KB_TEST_MONGO_URI')), {
    serverSelectionTimeoutMS: 5_000,
  });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  await ensureKnowledgeCollections(connection);
}, 60_000);

afterAll(async () => {
  if (connection) await connection.close();
});

describe('L1-B19-OPS-005 scheduler and stale status', () => {
  it('P01/S01 provides a durable scheduler record and runtime scheduler entrypoint', async () => {
    const models = registerKnowledgeModels(connection);
    const schedulerModels = Object.keys(models).filter((name) => /schedul/i.test(name));
    const runtimeSources = await Promise.all([
      readFile(join(root, 'projects/app/src/runtime/knowledge-runtime.ts'), 'utf8'),
      readFile(join(root, 'projects/app/src/runtime/knowledge-worker.ts'), 'utf8'),
    ]);
    await writeB19BEvidence('scheduler-contract.json', {
      schedulerModels,
      runtimeMentionsScheduler: runtimeSources.map((source) => /schedul|cron/i.test(source)),
    });
    expect(schedulerModels.length).toBeGreaterThan(0);
    expect(runtimeSources.every((source) => /schedul|cron/i.test(source))).toBe(true);
  });

  it('N01/Q01 marks a connector stale when its scheduled attempt is overdue', async () => {
    const now = new Date();
    const adapter = new S10StatusProbesAdapter({
      config: {
        externalModes: { model: 'mock' },
        s3: { provider: 'minio' },
        s10: {
          apiKeyHmacConfigured: true,
          quota: { requestsPerMinute: 30 },
        },
      } as never,
      connection,
      queues: new Map(),
      readiness: async () => ({
        status: 200,
        body: {
          checks: ['mongo', 'redis', 'postgres', 's3'].map((name) => ({
            name,
            status: 'ok',
            latencyMs: 1,
          })),
        },
      }),
      models: {
        async listModels() {
          return [];
        },
      },
      connectors: {
        async list() {
          return [
            {
              connectorId: '65f1e5b2a1c9d4b7e8f01234',
              provider: 'feishu',
              status: 'active',
              verificationStatus: 'EXTERNAL_UNVERIFIED',
              lastAttemptAt: new Date(now.getTime() - 2 * 60 * 60_000).toISOString(),
              nextSyncAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
            } as never,
          ];
        },
      },
    });
    const view = await adapter.probe(context);
    const connector = view.connectorProbes[0] as unknown as {
      stale?: boolean;
      lastAttemptAt?: string | null;
      nextSyncAt?: string | null;
      status?: string;
    };
    expect(connector).toMatchObject({
      status: 'active',
      stale: true,
      lastAttemptAt: expect.any(String),
      nextSyncAt: expect.any(String),
    });
  });

  it('applies the five-minute stale grace only to active enabled connectors', async () => {
    const now = new Date('2026-11-22T12:00:00.000Z');
    const adapter = new S10StatusProbesAdapter({
      config: {
        externalModes: { model: 'mock' },
        s3: { provider: 'minio' },
        s10: { apiKeyHmacConfigured: true, quota: { requestsPerMinute: 30 } },
      } as never,
      connection,
      queues: new Map(),
      readiness: async () => ({
        status: 200,
        body: {
          checks: ['mongo', 'redis', 'postgres', 's3'].map((name) => ({
            name,
            status: 'ok',
            latencyMs: 1,
          })),
        },
      }),
      models: {
        async listModels() {
          return [];
        },
      },
      connectors: {
        async list() {
          return [
            {
              connectorId: '65f1e5b2a1c9d4b7e8f01231',
              provider: 'feishu',
              status: 'active',
              verificationStatus: 'EXTERNAL_UNVERIFIED',
              lastAttemptAt: null,
              lastSuccessAt: null,
              nextSyncAt: '2026-11-22T11:55:00.000Z',
              lastError: null,
            },
            {
              connectorId: '65f1e5b2a1c9d4b7e8f01232',
              provider: 'feishu',
              status: 'paused',
              verificationStatus: 'EXTERNAL_UNVERIFIED',
              lastAttemptAt: null,
              lastSuccessAt: null,
              nextSyncAt: '2026-11-22T10:00:00.000Z',
              lastError: null,
            },
          ] as never;
        },
      },
      now: () => now,
    });
    const view = await adapter.probe(context);
    expect(view.connectorProbes.map((entry) => entry.stale)).toEqual([false, false]);
    const staleView = await new S10StatusProbesAdapter({
      config: {
        externalModes: { model: 'mock' },
        s3: { provider: 'minio' },
        s10: { apiKeyHmacConfigured: true, quota: { requestsPerMinute: 30 } },
      } as never,
      connection,
      queues: new Map(),
      readiness: async () => ({
        status: 200,
        body: {
          checks: ['mongo', 'redis', 'postgres', 's3'].map((name) => ({
            name,
            status: 'ok',
            latencyMs: 1,
          })),
        },
      }),
      models: {
        async listModels() {
          return [];
        },
      },
      connectors: {
        async list() {
          return [
            {
              connectorId: '65f1e5b2a1c9d4b7e8f01233',
              provider: 'feishu',
              status: 'active',
              verificationStatus: 'EXTERNAL_UNVERIFIED',
              lastAttemptAt: null,
              lastSuccessAt: null,
              nextSyncAt: '2026-11-22T11:54:59.999Z',
              lastError: null,
            },
          ] as never;
        },
      },
      now: () => now,
    }).probe(context);
    expect(staleView.connectorProbes[0]?.stale).toBe(true);
  });

  it('C01 status queries are read-only and do not mutate business collections', async () => {
    const models = registerKnowledgeModels(connection);
    const before = Object.fromEntries(
      await Promise.all(
        Object.entries(models).map(async ([name, model]) => [
          name,
          await model.countDocuments({ workspaceId: context.workspaceId }),
        ]),
      ),
    );
    const adapter = new S10StatusProbesAdapter({
      config: {
        externalModes: { model: 'mock' },
        s3: { provider: 'minio' },
        s10: {
          apiKeyHmacConfigured: true,
          quota: { requestsPerMinute: 30 },
        },
      } as never,
      connection,
      queues: new Map(),
      readiness: async () => ({
        status: 200,
        body: {
          checks: ['mongo', 'redis', 'postgres', 's3'].map((name) => ({
            name,
            status: 'ok',
            latencyMs: 1,
          })),
        },
      }),
      models: {
        async listModels() {
          return [];
        },
      },
      connectors: {
        async list() {
          return [];
        },
      },
    });
    await adapter.probe(context);
    const after = Object.fromEntries(
      await Promise.all(
        Object.entries(models).map(async ([name, model]) => [
          name,
          await model.countDocuments({ workspaceId: context.workspaceId }),
        ]),
      ),
    );
    expect(after).toEqual(before);
  });

  it('Q01 applies a run-scoped Redis and BullMQ prefix instead of writing global fixed keys', async () => {
    const sources = await Promise.all([
      readFile(
        join(root, 'packages/service/src/shared/config/knowledge-runtime-config.ts'),
        'utf8',
      ),
      readFile(join(root, 'projects/app/src/runtime/knowledge-runtime.ts'), 'utf8'),
      readFile(join(root, 'projects/app/src/runtime/knowledge-worker.ts'), 'utf8'),
    ]);
    expect(sources.join('\n')).toMatch(/(?:REDIS|QUEUE).*PREFIX|prefix:\s*config\./);
  });

  it('dispatches one durable sync job and replays without duplicating work', async () => {
    const models = registerKnowledgeModels(connection);
    for (const model of Object.values(models)) {
      await model.deleteMany({ workspaceId: context.workspaceId });
    }
    const catalog = new KnowledgeCatalogRepository(connection);
    const connectors = new KnowledgeConnectorRepository(
      connection,
      new KnowledgeCredentialCipher(`b19-scheduler-${B19_B_RUN_ID}`),
    );
    const schedules = new KnowledgeConnectorScheduleRepository(connection);
    const scheduler = new S10ConnectorSchedulerApplication({ schedules, connectors });
    const space = await catalog.createSpace(
      {
        kind: 'space',
        name: `Scheduler Space ${B19_B_RUN_ID}`,
        accessMode: 'workspace',
        sourceAclMode: 'inherited',
        sourcePermissionEnabled: true,
        autoSync: true,
      },
      context,
    );
    const connector = await connectors.connect(
      space.id,
      {
        provider: 'feishu',
        name: `Scheduler Connector ${B19_B_RUN_ID}`,
        credentials: {
          provider: 'feishu',
          appId: `safe-app-${B19_B_RUN_ID}`,
          appSecret: `safe-secret-${B19_B_RUN_ID}`,
        },
        config: { provider: 'feishu', folderToken: `safe-folder-${B19_B_RUN_ID}` },
        syncEnabled: true,
        syncIntervalMinutes: 15,
      },
      context,
    );
    await models.KnowledgeConnector.updateOne(
      { workspaceId: context.workspaceId, _id: connector.id },
      { $set: { nextSyncAt: new Date(Date.now() - 1_000) } },
    );
    const at = new Date(Date.now() + 1_000);
    const first = await scheduler.runOnce({ workerId: 'worker-a', now: at });
    expect(first.dispatched).toBe(1);
    expect(
      await models.KnowledgeJob.countDocuments({
        workspaceId: context.workspaceId,
        kind: 'sync',
      }),
    ).toBe(1);
    expect(
      await models.KnowledgeConnectorSchedule.findOne({
        workspaceId: context.workspaceId,
      }).lean(),
    ).toMatchObject({ status: 'dispatched' });
    const replay = await scheduler.runOnce({ workerId: 'worker-b', now: at });
    expect(replay.dispatched).toBe(0);
    expect(
      await models.KnowledgeConnectorSchedule.countDocuments({ workspaceId: context.workspaceId }),
    ).toBe(0);
    expect(
      await models.KnowledgeJob.countDocuments({
        workspaceId: context.workspaceId,
        kind: 'sync',
      }),
    ).toBe(1);
  });

  it('reconciles a missing schedule and isolates concurrent workers', async () => {
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeJob.deleteMany({ workspaceId: context.workspaceId, kind: 'sync' });
    const activeConnector = await models.KnowledgeConnector.findOne({
      workspaceId: context.workspaceId,
      deletedAt: null,
    }).lean();
    expect(activeConnector).not.toBeNull();
    await models.KnowledgeSpace.updateOne(
      { workspaceId: context.workspaceId, _id: activeConnector!.knowledgeSpaceId },
      { $set: { autoSync: true } },
    );
    await models.KnowledgeConnector.updateOne(
      { workspaceId: context.workspaceId, _id: activeConnector!._id },
      {
        $set: {
          status: 'active',
          syncEnabled: true,
          nextSyncAt: new Date(Date.now() - 1_000),
        },
        $inc: { version: 1 },
      },
    );
    const schedules = new KnowledgeConnectorScheduleRepository(connection);
    const connectors = new KnowledgeConnectorRepository(
      connection,
      new KnowledgeCredentialCipher(`b19-scheduler-${B19_B_RUN_ID}`),
    );
    const scheduler = new S10ConnectorSchedulerApplication({ schedules, connectors });
    await models.KnowledgeConnectorSchedule.deleteMany({ workspaceId: context.workspaceId });
    const at = new Date(Date.now() + 500);
    const results = await Promise.all([
      scheduler.runOnce({ workerId: 'worker-a', now: at }),
      scheduler.runOnce({ workerId: 'worker-b', now: at }),
    ]);
    expect(results.reduce((sum, result) => sum + result.dispatched, 0)).toBe(1);
    expect(
      new Set(
        (
          await models.KnowledgeJob.find({
            workspaceId: context.workspaceId,
            kind: 'sync',
          }).lean()
        ).map((job) => job.idempotencyKey),
      ).size,
    ).toBe(1);
  });

  it('KB-PARITY-016 skips automatic dispatch when the knowledge base gate is off', async () => {
    const models = registerKnowledgeModels(connection);
    const catalog = new KnowledgeCatalogRepository(connection);
    const connectors = new KnowledgeConnectorRepository(
      connection,
      new KnowledgeCredentialCipher(`b19-scheduler-gate-${B19_B_RUN_ID}`),
    );
    const schedules = new KnowledgeConnectorScheduleRepository(connection);
    const scheduler = new S10ConnectorSchedulerApplication({ schedules, connectors });
    const space = await catalog.createSpace(
      {
        kind: 'space',
        name: `Scheduler Gate ${B19_B_RUN_ID}`,
        accessMode: 'workspace',
        sourceAclMode: 'inherited',
        sourcePermissionEnabled: true,
        autoSync: false,
      },
      context,
    );
    const connector = await connectors.connect(
      space.id,
      {
        provider: 'feishu',
        name: `Scheduler Gate Connector ${B19_B_RUN_ID}`,
        credentials: {
          provider: 'feishu',
          appId: `safe-gate-app-${B19_B_RUN_ID}`,
          appSecret: `safe-gate-secret-${B19_B_RUN_ID}`,
        },
        config: { provider: 'feishu', folderToken: `safe-gate-folder-${B19_B_RUN_ID}` },
        syncEnabled: true,
        syncIntervalMinutes: 15,
      },
      context,
    );
    await models.KnowledgeConnector.updateOne(
      { workspaceId: context.workspaceId, _id: connector.id },
      { $set: { nextSyncAt: new Date(Date.now() - 1_000) } },
    );
    const jobsBefore = await models.KnowledgeJob.countDocuments({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: space.id,
      kind: 'sync',
    });
    const result = await scheduler.runOnce({
      workerId: 'worker-auto-sync-off',
      now: new Date(Date.now() + 1_000),
    });
    expect(result.dispatched).toBe(0);
    expect(
      await models.KnowledgeJob.countDocuments({
        workspaceId: context.workspaceId,
        knowledgeSpaceId: space.id,
        kind: 'sync',
      }),
    ).toBe(jobsBefore);
  });
});
