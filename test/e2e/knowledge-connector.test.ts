import { randomUUID } from 'node:crypto';
import { chromium, expect as expectUi } from '@playwright/test';
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

  it('ACC-UI-06 initializes provider and completes connect/update/sync/delete without credential echo', async () => {
    const browser = await chromium.launch({ headless: true });
    const connectorIdForUi = randomUUID();
    const connected = {
      id: connectorIdForUi,
      workspaceId,
      knowledgeSpaceId: spaceId,
      provider: 'yuque',
      name: 'Yuque UI',
      status: 'active',
      syncEnabled: true,
      syncIntervalMinutes: 60,
      nextSyncAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      cursorVersion: 1,
      version: 1,
      config: { provider: 'yuque' },
      credentialMetadata: {
        provider: 'yuque',
        schemaVersion: 1,
        keyVersion: 1,
        configured: true,
        redactedFields: ['token'],
      },
    };
    try {
      const pageContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await pageContext.addCookies([
        await consoleCookie({ baseUrl: app!.baseUrl, authToken, workspaceId }),
      ]);
      const page = await pageContext.newPage();
      let connectBody: unknown;
      let updateBody: unknown;
      let syncSubmitted = false;
      await page.route('**/v1/knowledge/spaces/*/connectors/yuque/connect', async (route) => {
        connectBody = route.request().postDataJSON();
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: connected }),
        });
      });
      await page.route(`**/v1/knowledge/connectors/${connectorIdForUi}`, async (route) => {
        if (route.request().method() === 'PATCH') {
          updateBody = route.request().postDataJSON();
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: { ...connected, name: 'Yuque UI updated', version: 2 },
            }),
          });
          return;
        }
        if (route.request().method() === 'DELETE') {
          await route.fulfill({
            status: 202,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: { id: connectorIdForUi, status: 'accepted', jobId: null },
            }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: syncSubmitted ? { ...connected, status: 'syncing', version: 2 } : connected,
          }),
        });
      });
      await page.route(`**/v1/knowledge/connectors/${connectorIdForUi}/sync`, async (route) => {
        syncSubmitted = true;
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              jobId: 'sync-ui-job',
              kind: 'sync',
              status: 'queued',
            },
          }),
        });
      });

      await page.goto(`${app!.baseUrl}/settings/connectors?spaceId=${spaceId}&provider=yuque`, {
        waitUntil: 'networkidle',
      });
      await expectUi(page.locator('select').first()).toHaveValue('yuque');
      await page.locator('input').nth(0).fill('Yuque UI');
      await page.locator('input').nth(2).fill('user-1');
      await page.locator('input').nth(3).fill('secret-token');
      await page.getByRole('button', { name: /创建连接器|Create connector/ }).click();
      await expectUi(page.getByText('Yuque UI').first()).toBeVisible();
      expect(connectBody).toMatchObject({
        provider: 'yuque',
        config: { provider: 'yuque' },
        credentials: { provider: 'yuque', userId: 'user-1', token: 'secret-token' },
      });
      await expectUi(page.locator('input').nth(3)).toHaveValue('');
      await expectUi(page.locator('body')).not.toContainText('secret-token');

      await page.locator('input').nth(0).fill('Yuque UI updated');
      const updateResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          response.url().endsWith(`/v1/knowledge/connectors/${connectorIdForUi}`),
      );
      await page.getByRole('button', { name: /更新连接器|Update connector/ }).click();
      expect((await updateResponse).status()).toBe(200);
      await expectUi(page.getByText('Yuque UI updated').first()).toBeVisible();
      expect(updateBody).toMatchObject({ version: 1, name: 'Yuque UI updated' });
      expect(updateBody).not.toHaveProperty('credentials');

      await page.getByRole('button', { name: /提交同步|Submit sync/ }).click();
      await expectUi(page.getByRole('status')).toContainText(/sync-ui-job/);
      await expectUi(page.getByText('syncing')).toBeVisible();

      page.once('dialog', (dialog) => void dialog.accept());
      await page.getByRole('button', { name: /删除连接器|Delete connector/ }).click();
      await expectUi(page.getByRole('status')).toContainText(/删除|deletion/i);
      await pageContext.close();
    } finally {
      await browser.close();
    }
  });
});
