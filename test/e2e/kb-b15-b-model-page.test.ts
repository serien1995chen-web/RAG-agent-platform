import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  apiHeaders,
  consoleCookie,
  createSpace,
  startS4App,
  type S4AppHarness,
} from './s4-app-harness';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b15_ui_${suffix}`;
const memberId = `mem_b15_ui_${suffix}`;
const authToken = `b15-ui-token-${suffix}`;

let app: S4AppHarness;
let spaceId = '';
let browser: Browser | undefined;

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_b15_b?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-local';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  spaceId = await createSpace({
    baseUrl: app.baseUrl,
    authToken,
    workspaceId,
    suffix,
  });
}, 180_000);

afterAll(async () => {
  if (app && spaceId) {
    const headers = apiHeaders({ authToken, workspaceId });
    const current = await fetch(`${app.baseUrl}/v1/knowledge/spaces/${spaceId}`, { headers });
    const payload = (await current.json()) as {
      success?: boolean;
      data?: { version: number; referenceRevision: number };
    };
    if (current.ok && payload.success && payload.data) {
      const deletion = await fetch(`${app.baseUrl}/v1/knowledge/spaces/${spaceId}`, {
        method: 'DELETE',
        headers: {
          ...headers,
          'content-type': 'application/json',
          'idempotency-key': `b15-page-cleanup-${suffix}`,
        },
        body: JSON.stringify({
          version: payload.data.version,
          expectedReferenceRevision: payload.data.referenceRevision,
          referenceStrategy: 'block',
        }),
      });
      if (!deletion.ok) {
        const safe = (await deletion.json().catch(() => ({}))) as {
          error?: { code?: string };
        };
        console.error(
          `B15_E2E_CLEANUP_FAILED status=${deletion.status} code=${safe.error?.code ?? 'unknown'}`,
        );
      }
    }
  }
  await browser?.close();
  await app?.close();
}, 30_000);

describe('L1-B15-B Web model gateway configuration', () => {
  it('L1-B15-B-MODEL-003/004-UI01 exposes rerank model, query optimization model, prompt and dependency failure states', async () => {
    const cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
    const evidenceDir = resolve(
      process.env.B15_EVIDENCE_DIR ?? join(process.cwd(), 'test-results', 'b15', 'e2e'),
    );
    mkdirSync(evidenceDir, { recursive: true });
    browser = await chromium.launch({ headless: true });
    const browserContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await browserContext.addCookies([cookie]);
    const page = await browserContext.newPage();
    const consoleErrors: string[] = [];
    const networkErrors: Array<{ url: string; status: number }> = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        networkErrors.push({ url: response.url(), status: response.status() });
      }
    });
    await page.goto(`${app.baseUrl}/spaces/${spaceId}/search`, { waitUntil: 'networkidle' });

    await playwrightExpect(page.getByRole('button', { name: '搜索配置' })).toBeVisible();
    await page.getByRole('button', { name: '搜索配置' }).click();
    await playwrightExpect(page.getByRole('dialog', { name: '知识库搜索配置' })).toBeVisible();
    await page.screenshot({
      path: join(evidenceDir, 'b15-model-settings.png'),
      fullPage: true,
    });
    const accessibility = await new AxeBuilder({ page }).analyze();
    writeFileSync(
      join(evidenceDir, 'b15-model-settings-evidence.json'),
      `${JSON.stringify(
        {
          consoleErrors,
          networkErrors,
          accessibility: accessibility.violations.map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            nodes: violation.nodes.length,
          })),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await playwrightExpect(page.getByRole('tab', { name: '搜索方式' })).toBeVisible();
    await playwrightExpect(page.getByRole('tab', { name: '搜索过滤' })).toBeVisible();
    await playwrightExpect(page.getByRole('tab', { name: '问题优化' })).toBeVisible();
    await playwrightExpect(page.getByLabel('重排模型')).toHaveCount(0);
    const rerank = page.getByLabel('结果重排');
    if (await rerank.isVisible()) {
      await rerank.check();
      await playwrightExpect(page.getByLabel('重排模型')).toBeVisible();
      await playwrightExpect(page.getByLabel('重排候选数')).toBeVisible();
    } else {
      await playwrightExpect(page.getByText('未部署重排模型')).toBeVisible();
    }
    await page.getByRole('tab', { name: '问题优化' }).click();
    await playwrightExpect(page.getByLabel('问题优化模型')).toHaveCount(0);
    await page.getByLabel('启用问题优化').check();
    await playwrightExpect(page.getByLabel('问题优化模型')).toBeVisible();
    await playwrightExpect(page.getByLabel('问题优化背景 Prompt')).toBeVisible();
    await playwrightExpect
      .soft(page.getByText('当前合同未提供查询扩展 Prompt 和重排模型选择字段'))
      .toHaveCount(0);
  }, 120_000);
});
