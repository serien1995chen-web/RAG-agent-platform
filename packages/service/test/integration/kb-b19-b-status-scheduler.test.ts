import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  b19bTenantContext,
  mongoUriForRun,
  writeB19BEvidence,
} from '../../../../test/fixtures/b19-b/support';
import { S10StatusProbesAdapter } from '../../src/modules/knowledge/adapter/s10-status-probes.adapter';
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
});
