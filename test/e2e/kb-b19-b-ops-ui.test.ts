import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as uiExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  B19_B_RUN_ID,
  B19_B_WORKSPACE_A,
  b19bEvidenceDir,
  writeB19BEvidence,
} from '../fixtures/b19-b/support';
import {
  createKnowledgeMongoConnection,
  registerKnowledgeModels,
} from '../../packages/service/src';
import {
  apiHeaders,
  consoleCookie,
  createSpace,
  requiredEnv,
  startS4App,
  type S4AppHarness,
} from './s4-app-harness';

const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
const workspaceId = B19_B_WORKSPACE_A;
const memberId = `${B19_B_RUN_ID}-ui-member`;
const authToken = `${B19_B_RUN_ID}-ui-token`;
let app: S4AppHarness;
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let spaceId = '';
let connectorId = '';

async function screenshot(page: Page, name: string) {
  const directory = join(b19bEvidenceDir(), 'ui');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
}

async function createConnector() {
  const response = await fetch(
    `${app.baseUrl}/v1/knowledge/spaces/${spaceId}/connectors/feishu/connect`,
    {
      method: 'POST',
      headers: {
        ...apiHeaders({
          authToken,
          workspaceId,
          idempotencyKey: `b19-b-ui-connect-${suffix}`,
        }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'feishu',
        name: `B19-B UI connector ${suffix}`,
        credentials: {
          provider: 'feishu',
          appId: `safe-app-${suffix}`,
          appSecret: `safe-secret-${suffix}`,
        },
        config: { provider: 'feishu', folderToken: `safe-folder-${suffix}` },
        syncEnabled: true,
        syncIntervalMinutes: 60,
      }),
    },
  );
  const payload = (await response.json()) as {
    success: boolean;
    data?: { id: string };
    error?: { code: string };
  };
  expect(response.status, JSON.stringify(payload)).toBe(201);
  expect(payload.success).toBe(true);
  connectorId = payload.data!.id;
}

beforeAll(async () => {
  app = await startS4App({
    suffix: `b19-b-${suffix}`,
    workspaceId,
    memberId,
    authToken,
    connectorMode: 'mock',
  });
  spaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
  await createConnector();
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  registerKnowledgeModels(connection);
}, 240_000);

afterAll(async () => {
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
  await app?.close();
});

describe('L1-B19-OPS-005-UI01 current product entry', () => {
  it('TEST-X-COMPOSE-READY / TEST-X-SAAS-READY exposes real dependency readiness without fake healthy', async () => {
    const health = await fetch(`${app.baseUrl}/healthz`);
    expect(health.status).toBe(200);
    const ready = await fetch(`${app.baseUrl}/readyz`);
    expect(ready.status).toBe(200);
    const readyPayload = (await ready.json()) as {
      success: boolean;
      data: {
        checks: Array<{ name: string; status: string }>;
      };
    };
    expect(readyPayload.success).toBe(true);
    expect(
      Object.fromEntries(readyPayload.data.checks.map((check) => [check.name, check.status])),
    ).toMatchObject({
      mongo: 'ok',
      redis: 'ok',
      postgres: 'ok',
      s3: 'ok',
    });
    const statusResponse = await fetch(`${app.baseUrl}/v1/knowledge/operations/status`, {
      headers: apiHeaders({ authToken, workspaceId }),
    });
    expect(statusResponse.status).toBe(200);
    const statusPayload = (await statusResponse.json()) as {
      success: boolean;
      data: {
        status: string;
        modelProbe: { verificationStatus: string };
        dependencies: Record<string, { verificationStatus: string }>;
      };
    };
    expect(statusPayload.data.dependencies.mongo.verificationStatus).toBe('REAL_VERIFIED');
    expect(statusPayload.data.modelProbe.verificationStatus).toBe('FIXTURE_VERIFIED');
    expect(statusPayload.data.status).toBe('degraded');
    await writeB19BEvidence('compose-saas-readiness.json', {
      healthStatus: health.status,
      readyStatus: ready.status,
      checks: readyPayload.data.checks,
      opsStatus: statusPayload.data.status,
      modelProbe: statusPayload.data.modelProbe.verificationStatus,
    });
  });

  it('starts the canonical worker and writes its readiness marker', async () => {
    const root = resolve(import.meta.dirname, '../..');
    const readyFile = join(b19bEvidenceDir(), `worker-ready-${suffix}`);
    const worker = spawn(process.execPath, ['projects/app/dist/workers/worker.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        KB_ENV: 'test',
        KB_APP_WORKER_MODE: 'worker',
        KB_INSTANCE_ID: `b19-b-worker-${suffix}`,
        KB_WORKER_READY_FILE: readyFile,
        KB_MONGO_URI: requiredEnv('KB_TEST_MONGO_URI'),
        KB_REDIS_URL: requiredEnv('KB_TEST_REDIS_URL'),
        KB_PG_URL: requiredEnv('KB_TEST_PG_URL'),
        KB_S3_ENDPOINT: requiredEnv('KB_TEST_S3_ENDPOINT'),
        KB_S3_REGION: process.env.KB_TEST_S3_REGION || 'us-east-1',
        KB_S3_BUCKET: requiredEnv('KB_TEST_S3_BUCKET'),
        KB_S3_ACCESS_KEY_REF: 'env:B19_B_S3_ACCESS',
        KB_S3_SECRET_KEY_REF: 'env:B19_B_S3_SECRET',
        B19_B_S3_ACCESS: requiredEnv('KB_TEST_S3_ACCESS_KEY'),
        B19_B_S3_SECRET: requiredEnv('KB_TEST_S3_SECRET_KEY'),
        KB_FILE_PUBLIC_BASE_URL: app.baseUrl,
        KB_FILE_TICKET_SECRET_REF: 'env:B19_B_FILE_TICKET_SECRET',
        B19_B_FILE_TICKET_SECRET: `b19-b-file-ticket-${suffix}-secret-32-bytes-minimum`,
        KB_CREDENTIAL_ENCRYPTION_KEY_REF: 'env:B19_B_CREDENTIAL_KEY',
        B19_B_CREDENTIAL_KEY: `b19-b-credential-${suffix}-key-32-bytes-minimum`,
        KB_CITATION_SIGNING_SECRET_REF: 'env:B19_B_CITATION_SECRET',
        B19_B_CITATION_SECRET: `b19-b-citation-${suffix}-secret-32-bytes-minimum`,
        API_KEY_HMAC_SECRET_FILE: join(root, 'test/fixtures/s10/api-key-hmac.secret'),
        KB_AUTH_MODE: 'mock',
        KB_MOCK_AUTH_TOKEN: authToken,
        KB_MOCK_WORKSPACE_ID: workspaceId,
        KB_MOCK_MEMBER_ID: memberId,
        KB_MOCK_SCOPES: 'knowledge:read,knowledge:write,knowledge:manage,knowledge:admin',
        KB_MOCK_WORKSPACE_OWNER: 'true',
        KB_EXTERNAL_MODEL_MODE: 'mock',
        KB_EXTERNAL_OCR_MODE: 'mock',
        KB_EXTERNAL_CONNECTOR_MODE: 'mock',
        KB_LOG_LEVEL: 'error',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    worker.stdout?.on('data', (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-20_000);
    });
    worker.stderr?.on('data', (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-20_000);
    });
    try {
      const deadline = Date.now() + 60_000;
      let ready = false;
      while (Date.now() < deadline) {
        if (worker.exitCode !== null) {
          throw new Error(`worker exited before ready\n${output}`);
        }
        try {
          await access(readyFile);
          ready = true;
          break;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 250));
        }
      }
      expect(ready, `worker readiness marker missing\n${output}`).toBe(true);
      await writeB19BEvidence('worker-readiness.json', {
        readyFile,
        ready,
        output,
        pid: worker.pid,
      });
    } finally {
      if (worker.exitCode === null) worker.kill('SIGTERM');
      await new Promise((resolveWait) => setTimeout(resolveWait, 750));
      await unlink(readyFile).catch(() => undefined);
    }
  }, 90_000);

  it('navigates from the Knowledge detail Info rail to the connector business entry', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
      });
      await context.addCookies([
        await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId }),
      ]);
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      await page.goto(`${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=collection`, {
        waitUntil: 'networkidle',
      });
      await uiExpect(page.getByRole('complementary', { name: '知识库信息' })).toBeVisible();
      await page.getByRole('button', { name: '管理连接器' }).click();
      await page.waitForURL(/\/settings\/connectors\?/);
      expect(page.url()).toContain(`spaceId=${spaceId}`);
      await uiExpect(page.getByRole('heading', { name: '数据源连接器' })).toBeVisible();
      await uiExpect(page.getByText('配置飞书等外部来源，管理同步状态和凭证。')).toBeVisible();
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(
        accessibility.violations.filter(
          (violation) => violation.impact === 'serious' || violation.impact === 'critical',
        ),
      ).toEqual([]);
      expect(consoleErrors).toEqual([]);
      await screenshot(page, 'connector-entry-1440x900');
      await context.close();
    } finally {
      await browser.close();
    }
  });

  it('shows failed/stale details and keeps the status controls accessible', async () => {
    const models = registerKnowledgeModels(connection);
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    await models.KnowledgeConnector.updateOne(
      { workspaceId, _id: connectorId },
      {
        $set: {
          status: 'failed',
          syncEnabled: true,
          nextSyncAt: old,
          lastAttemptAt: old,
          lastSuccessAt: new Date(old.getTime() - 60 * 60_000),
          lastError: {
            code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
            message: 'Provider request timed out',
            retryable: true,
          },
        },
        $inc: { version: 1 },
      },
    );
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
      });
      await context.addCookies([
        await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId }),
      ]);
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      await page.goto(
        `${app.baseUrl}/settings/connectors?spaceId=${spaceId}&provider=feishu&connectorId=${connectorId}`,
        { waitUntil: 'networkidle' },
      );
      await screenshot(page, 'connector-failed-stale-1440x900');
      await uiExpect(page.getByText('失败', { exact: true })).toBeVisible();
      await uiExpect(page.getByText(/Provider request timed out/)).toBeVisible();

      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        label: document.activeElement?.getAttribute('aria-label'),
        text: document.activeElement?.textContent?.trim().slice(0, 80),
      }));
      expect(focused.tag).toBeTruthy();
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(
        accessibility.violations.filter(
          (violation) => violation.impact === 'serious' || violation.impact === 'critical',
        ),
      ).toEqual([]);
      expect(consoleErrors).toEqual([]);
      await writeB19BEvidence('ui-connector-observation.json', {
        url: page.url(),
        locale: 'zh-CN',
        viewport: { width: 1440, height: 900 },
        connector: await models.KnowledgeConnector.findById(connectorId).lean(),
        focused,
        consoleErrors,
        axeSeriousOrCritical: accessibility.violations
          .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
          .map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            help: violation.help,
          })),
      });
      await context.close();
    } finally {
      await browser.close();
    }
  });

  it('shows last attempt, last success and stale state for an overdue connector', async () => {
    await registerKnowledgeModels(connection).KnowledgeConnector.updateOne(
      { workspaceId, _id: connectorId },
      {
        $set: {
          status: 'active',
          syncEnabled: true,
          nextSyncAt: new Date(Date.now() - 3 * 60 * 60_000),
          lastAttemptAt: new Date(Date.now() - 3 * 60 * 60_000),
          lastSuccessAt: new Date(Date.now() - 4 * 60 * 60_000),
          lastError: null,
        },
        $inc: { version: 1 },
      },
    );
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
      });
      await context.addCookies([
        await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId }),
      ]);
      const page = await context.newPage();
      await page.goto(
        `${app.baseUrl}/settings/connectors?spaceId=${spaceId}&provider=feishu&connectorId=${connectorId}`,
        { waitUntil: 'networkidle' },
      );
      await uiExpect(page.getByText(/\blastAttemptAt\b/)).toBeVisible();
      await uiExpect(page.getByText(/\blastSuccessAt\b/)).toBeVisible();
      await uiExpect(page.getByText(/过期|stale|已陈旧/i)).toBeVisible();
      await context.close();
    } finally {
      await browser.close();
    }
  });

  it('persists the automatic sync switch after refresh and disables manual sync when paused', async () => {
    await registerKnowledgeModels(connection).KnowledgeConnector.updateOne(
      { workspaceId, _id: connectorId },
      {
        $set: {
          status: 'active',
          syncEnabled: true,
          nextSyncAt: new Date(Date.now() + 60 * 60_000),
          lastAttemptAt: new Date(Date.now() - 60_000),
          lastSuccessAt: new Date(Date.now() - 60_000),
          lastError: null,
        },
        $inc: { version: 1 },
      },
    );
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
      });
      await context.addCookies([
        await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId }),
      ]);
      const page = await context.newPage();
      await page.goto(
        `${app.baseUrl}/settings/connectors?spaceId=${spaceId}&provider=feishu&connectorId=${connectorId}`,
        { waitUntil: 'networkidle' },
      );
      const syncToggle = page.getByRole('checkbox', { name: '启用同步' });
      await uiExpect(syncToggle).toBeChecked();
      await page.getByText('启用同步', { exact: true }).click();
      await uiExpect(syncToggle).not.toBeChecked();
      const update = page.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          response.url().endsWith(`/v1/knowledge/connectors/${connectorId}`),
      );
      await page.getByRole('button', { name: '更新连接器' }).click();
      await uiExpect((await update).status()).toBe(200);
      await page.reload({ waitUntil: 'networkidle' });
      await uiExpect(page.getByRole('checkbox', { name: '启用同步' })).not.toBeChecked();
      await uiExpect(page.getByRole('button', { name: '提交同步' })).toBeDisabled();
      const document = await registerKnowledgeModels(connection)
        .KnowledgeConnector.findById(connectorId)
        .lean();
      expect(document).toMatchObject({ status: 'paused', syncEnabled: false, nextSyncAt: null });
      await writeB19BEvidence('ui-auto-sync-persistence.json', {
        connectorId,
        status: document?.status,
        syncEnabled: document?.syncEnabled,
        nextSyncAt: document?.nextSyncAt,
      });
      await screenshot(page, 'connector-paused-1440x900');
      await context.close();
    } finally {
      await browser.close();
    }
  });

  it('blocks model configuration when the model catalog fails and exposes a retryable reason', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
      });
      await context.addCookies([
        await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId }),
      ]);
      const page = await context.newPage();
      await page.route('**/v1/knowledge/models**', async (route) => {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: {
              code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
              messageKey: 'errors.dependencyUnavailable',
              params: { dependency: 'model_catalog' },
              retryable: true,
            },
          }),
        });
      });
      await page.goto(`${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=collection`, {
        waitUntil: 'networkidle',
      });
      await page.getByRole('button', { name: '编辑模型配置' }).click();
      const dialog = page.getByRole('dialog', { name: '模型配置' });
      await uiExpect(dialog).toBeVisible();
      await screenshot(page, 'model-catalog-failure-1440x900');
      await uiExpect(
        dialog.getByText(/模型目录暂不可用|模型目录.*(失败|不可用)|dependencyUnavailable/i),
      ).toBeVisible();
      await uiExpect(dialog.getByRole('button', { name: '保存' })).toBeDisabled();
      await uiExpect(dialog.getByRole('button', { name: /重试|重新加载/ })).toBeVisible();
      await context.close();
    } finally {
      await browser.close();
    }
  });
});
