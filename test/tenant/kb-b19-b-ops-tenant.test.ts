import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  B19_B_RUN_ID,
  b19bTenantContext,
  mongoUriForRun,
  writeB19BEvidence,
} from '../fixtures/b19-b/support';
import { S10StatusApplication } from '../../packages/service/src/modules/knowledge/application/s10-status.application';
import { KnowledgeCredentialCipher } from '../../packages/service/src/modules/knowledge/adapter/credential-cipher';
import { KnowledgeCatalogRepository } from '../../packages/service/src/modules/knowledge/repository/catalog.repository';
import { KnowledgeConnectorRepository } from '../../packages/service/src/modules/knowledge/repository/connector.repository';
import { S10OperationsRepository } from '../../packages/service/src/modules/knowledge/repository/s10-operations.repository';
import { KnowledgeAuditRepository } from '../../packages/service/src/shared/persistence/knowledge/audit';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';

const workspaceA = `b19-b-tenant-a-${B19_B_RUN_ID}`.slice(0, 64);
const workspaceB = `b19-b-tenant-b-${B19_B_RUN_ID}`.slice(0, 64);
const contextA = b19bTenantContext('tenant-a', workspaceA);
const contextB = b19bTenantContext('tenant-b', workspaceB);
const nonAdmin = { ...contextA, scopes: ['knowledge:read'] };

let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let catalog: KnowledgeCatalogRepository;
let connectors: KnowledgeConnectorRepository;
let audits: KnowledgeAuditRepository;
let operations: S10OperationsRepository;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

async function cleanup(): Promise<void> {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId: { $in: [workspaceA, workspaceB] } });
  }
}

beforeAll(async () => {
  connection = await createKnowledgeMongoConnection(
    mongoUriForRun(requiredEnv('KB_TEST_MONGO_URI')),
  );
  await ensureKnowledgeCollections(connection);
  catalog = new KnowledgeCatalogRepository(connection);
  connectors = new KnowledgeConnectorRepository(
    connection,
    new KnowledgeCredentialCipher(`b19-b-tenant-credential-${B19_B_RUN_ID}`),
  );
  audits = new KnowledgeAuditRepository(connection);
  operations = new S10OperationsRepository(connection, { enqueue: async () => ({}) } as never);
}, 60_000);

beforeEach(cleanup);

afterAll(async () => {
  if (!connection) return;
  await cleanup();
  await writeB19BEvidence('tenant-cleanup.json', {
    workspaceIds: [workspaceA, workspaceB],
  });
  await connection.close();
});

describe('TEST-X-TENANT-GUARD B19 audit/status/connector', () => {
  it('isolates audit and connector reads without leaking existence', async () => {
    const spaceA = await catalog.createSpace(
      {
        kind: 'space',
        name: `Tenant A ${B19_B_RUN_ID}`,
        accessMode: 'workspace',
        sourceAclMode: 'inherited',
        sourcePermissionEnabled: true,
      },
      contextA,
    );
    const connector = await connectors.connect(
      spaceA.id,
      {
        provider: 'feishu',
        name: `Tenant A Connector ${B19_B_RUN_ID}`,
        credentials: {
          provider: 'feishu',
          appId: `app-${B19_B_RUN_ID}`,
          appSecret: `secret-${B19_B_RUN_ID}`,
        },
        config: { provider: 'feishu', folderToken: `folder-${B19_B_RUN_ID}` },
        syncEnabled: true,
        syncIntervalMinutes: 60,
      },
      contextA,
    );
    await audits.appendStandalone(
      {
        knowledgeSpaceId: spaceA.id,
        action: 'connector.connect',
        resourceType: 'connector',
        resourceId: connector.id,
        outcome: 'succeeded',
        safeDiff: { provider: 'feishu', version: connector.version },
      },
      contextA,
    );

    expect((await operations.list({ limit: 20 }, contextA)).items).toHaveLength(1);
    await expect(operations.list({ limit: 20 }, contextB)).resolves.toEqual({
      items: [],
      pageInfo: { nextCursor: null, hasMore: false },
    });

    const foreignError = await connectors.get(connector.id, contextB).catch((error) => error);
    expect(foreignError).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    expect(JSON.stringify(foreignError)).not.toContain(spaceA.id);
    expect(JSON.stringify(foreignError)).not.toContain(`Tenant A Connector ${B19_B_RUN_ID}`);
  });

  it('rejects non-admin and restricted-Space status probes before reading status', async () => {
    const probe = vi.fn(async () => {
      throw new Error('must not probe');
    });
    const status = new S10StatusApplication({ probe });
    await expect(status.get(nonAdmin)).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_FORBIDDEN',
          details: { scope: 'knowledge:admin' },
        },
      },
    });
    await expect(
      status.get({
        ...contextA,
        apiKeySpaceIds: ['65f1e5b2a1c9d4b7e8f01234'],
      }),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_FORBIDDEN',
          details: { reason: 'workspace_wide_api_key_required' },
        },
      },
    });
    expect(probe).not.toHaveBeenCalled();
  });
});
