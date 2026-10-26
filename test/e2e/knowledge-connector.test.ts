import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import {
  apiHeaders,
  consoleCookie,
  createSpace,
  requiredEnv,
  startS4App,
  verifyResponsivePage,
  type S4AppHarness,
} from './s4-app-harness';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s4_connector_e2e_${suffix}`;
const memberId = `mem_s4_connector_e2e_${suffix}`;
const authToken = `s4-connector-e2e-token-${suffix}`;

let app: S4AppHarness | undefined;
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>> | undefined;
let spaceId = '';
let connectorId = '';

beforeAll(async () => {
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  spaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  registerKnowledgeModels(connection);
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
});

describe('TEST-ING-007-BLOCK and ACC-UI-06 connector', () => {
  it('connects, catalogs and submits sync without returning secrets or advancing cursor', async () => {
    const connect = await fetch(
      `${app!.baseUrl}/v1/knowledge/spaces/${spaceId}/connectors/feishu/connect`,
      {
        method: 'POST',
        headers: {
          ...apiHeaders({ authToken, workspaceId, idempotencyKey: `s4-connect-${suffix}` }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'feishu',
          name: 'Feishu Support',
          credentials: { provider: 'feishu', appId: 'app-id', appSecret: 'e2e-secret' },
          config: { provider: 'feishu', folderToken: 'safe-token' },
          syncEnabled: true,
          syncIntervalMinutes: 60,
        }),
      },
    );
    const connected = (await connect.json()) as {
      success: boolean;
      data: { id: string; cursorVersion: number; credentialMetadata: Record<string, unknown> };
    };
    connectorId = connected.data.id;
    expect(connect.status).toBe(201);
    expect(JSON.stringify(connected)).not.toContain('e2e-secret');
    expect(JSON.stringify(connected)).not.toContain('credentialCiphertext');
    expect(connected.data.credentialMetadata).toMatchObject({
      provider: 'feishu',
      configured: true,
      redactedFields: ['appSecret'],
    });

    const catalog = await fetch(
      `${app!.baseUrl}/v1/knowledge/spaces/${spaceId}/connectors/feishu/catalog`,
      {
        method: 'POST',
        headers: {
          ...apiHeaders({ authToken, workspaceId, idempotencyKey: `s4-catalog-${suffix}` }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ rootId: 'root' }),
      },
    );
    const catalogPayload = (await catalog.json()) as {
      data: { items: unknown[]; verificationStatus: string };
    };
    expect(catalog.status).toBe(200);
    expect(catalogPayload.data.items.length).toBeGreaterThan(0);
    expect(catalogPayload.data.verificationStatus).toBe('EXTERNAL_UNVERIFIED');

    const sync = await fetch(`${app!.baseUrl}/v1/knowledge/connectors/${connectorId}/sync`, {
      method: 'POST',
      headers: {
        ...apiHeaders({ authToken, workspaceId, idempotencyKey: `s4-sync-${suffix}` }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ full: false }),
    });
    const syncPayload = (await sync.json()) as { data: { kind: string; status: string } };
    expect(sync.status).toBe(202);
    expect(syncPayload.data).toMatchObject({ kind: 'sync', status: 'queued' });
    const document = await connection!.models.KnowledgeConnector.findById(connectorId).lean();
    expect(document?.cursorVersion).toBe(connected.data.cursorVersion);
    expect(document?.status).toBe('syncing');
  });

  it('renders connector settings safely at 360/768/1200', async () => {
    await verifyResponsivePage({
      baseUrl: app!.baseUrl,
      path: `/settings/connectors?spaceId=${spaceId}&provider=feishu&connectorId=${connectorId}`,
      cookie: await consoleCookie({ baseUrl: app!.baseUrl, authToken, workspaceId }),
      screenshotPrefix: 'connectors',
    });
  });
});
