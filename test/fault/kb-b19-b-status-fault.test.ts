import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  B19_B_RUN_ID,
  b19bTenantContext,
  mongoUriForRun,
  writeB19BEvidence,
} from '../fixtures/b19-b/support';
import { S10StatusApplication } from '../../packages/service/src/modules/knowledge/application/s10-status.application';
import { KnowledgeCredentialCipher } from '../../packages/service/src/modules/knowledge/adapter/credential-cipher';
import { S10StatusProbesAdapter } from '../../packages/service/src/modules/knowledge/adapter/s10-status-probes.adapter';
import { KnowledgeCatalogRepository } from '../../packages/service/src/modules/knowledge/repository/catalog.repository';
import { KnowledgeConnectorRepository } from '../../packages/service/src/modules/knowledge/repository/connector.repository';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';

const workspaceId = `b19-b-status-fault-${B19_B_RUN_ID}`.slice(0, 64);
const context = b19bTenantContext('status-fault', workspaceId);
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let catalog: KnowledgeCatalogRepository;
let connectors: KnowledgeConnectorRepository;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

async function cleanup(): Promise<void> {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
}

function adapter(input: {
  readiness?: () => Promise<{
    status: number;
    body: { checks: Array<{ name: string; status: string; latencyMs: number }> };
  }>;
  modelHealth?: { probe: () => Promise<{ verifiedTypes: string[] }> };
}) {
  return new S10StatusProbesAdapter({
    config: {
      externalModes: { model: 'real' },
      s3: { provider: 'minio' },
      s10: {
        apiKeyHmacConfigured: true,
        quota: { requestsPerMinute: 30 },
      },
    } as never,
    connection,
    queues: new Map(),
    readiness:
      input.readiness ??
      (async () => ({
        status: 200,
        body: {
          checks: ['mongo', 'redis', 'postgres', 's3'].map((name) => ({
            name,
            status: 'ok',
            latencyMs: 1,
          })),
        },
      })),
    models: {
      async listModels() {
        return [
          {
            modelId: `model-${B19_B_RUN_ID}`,
            displayName: 'Safe model',
            type: 'llm',
            capabilities: ['chat'],
            dimension: null,
            authorized: true,
          },
        ];
      },
    },
    modelHealth: input.modelHealth,
    connectors: {
      async list() {
        return [];
      },
    },
  });
}

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(
    mongoUriForRun(requiredEnv('KB_TEST_MONGO_URI')),
  );
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  connectors = new KnowledgeConnectorRepository(
    connection,
    new KnowledgeCredentialCipher(`b19-b-status-fault-credential-${B19_B_RUN_ID}`),
  );
}, 60_000);

beforeEach(cleanup);

afterAll(async () => {
  if (!connection) return;
  await cleanup();
  await writeB19BEvidence('status-fault-cleanup.json', { workspaceId });
  await connection.close();
});

describe('L1-B19-OPS-005-F01 status and provider recovery', () => {
  it('times out a hanging model probe without hanging the status request', async () => {
    vi.useFakeTimers();
    try {
      const pending = adapter({
        modelHealth: {
          probe: () => new Promise(() => undefined),
        },
      }).probe(context);
      await vi.advanceTimersByTimeAsync(60_001);
      const view = await pending;
      expect(view.modelProbe).toMatchObject({
        status: 'unavailable',
        verificationStatus: 'UNKNOWN',
      });
      await expect(
        new S10StatusApplication(
          adapter({
            modelHealth: { probe: async () => Promise.reject(new Error('timeout')) },
          }),
        ).get(context),
      ).resolves.toMatchObject({ status: 'degraded' });
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it('degrades to UNKNOWN rather than throwing when readiness fails', async () => {
    const view = await adapter({
      readiness: async () => {
        throw new Error('mongo/redis/pgvector/s3 unavailable');
      },
    })
      .probe(context)
      .catch(() => null);
    expect(view).toBeNull();
    const status = await new S10StatusApplication(
      adapter({
        readiness: async () => {
          throw new Error('dependency unavailable');
        },
      }),
    ).get(context);
    expect(status.status).toBe('degraded');
    expect(status.dependencies.mongo.verificationStatus).toBe('UNKNOWN');
    expect(status.modelProbe.verificationStatus).toBe('UNKNOWN');
  });

  it('keeps a newer failed connector terminal state from being overwritten by a later success', async () => {
    const space = await catalog.createSpace(
      {
        kind: 'space',
        name: `Status Fault Space ${B19_B_RUN_ID}`,
        accessMode: 'workspace',
        sourceAclMode: 'inherited',
        sourcePermissionEnabled: true,
      },
      context,
    );
    const connector = await connectors.connect(
      space.id,
      {
        provider: 'feishu',
        name: `Status Fault Connector ${B19_B_RUN_ID}`,
        credentials: {
          provider: 'feishu',
          appId: `safe-app-${B19_B_RUN_ID}`,
          appSecret: `safe-secret-${B19_B_RUN_ID}`,
        },
        config: { provider: 'feishu', folderToken: `safe-folder-${B19_B_RUN_ID}` },
        syncEnabled: true,
        syncIntervalMinutes: 60,
      },
      context,
    );
    await connectors.markSyncing(
      connector.id,
      {
        full: false,
        requestHash: `request-${B19_B_RUN_ID}`,
        idempotencyKey: `fault-sync-${B19_B_RUN_ID}`,
      },
      context,
    );
    await connectors.completeSync(
      { connectorId: connector.id, success: false, errorCode: 'KNOWLEDGE_PROVIDER_UNAVAILABLE' },
      context,
    );
    const failed = await connectors.get(connector.id, context);
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toMatchObject({ code: 'KNOWLEDGE_PROVIDER_UNAVAILABLE' });
    await connectors.completeSync({ connectorId: connector.id, success: true }, context);
    const persisted = await connectors.get(connector.id, context);
    expect(persisted.status).toBe('failed');
    expect(persisted.lastError).toMatchObject({ code: 'KNOWLEDGE_PROVIDER_UNAVAILABLE' });
    expect(persisted.lastSuccessAt).toBeNull();
  });
});
