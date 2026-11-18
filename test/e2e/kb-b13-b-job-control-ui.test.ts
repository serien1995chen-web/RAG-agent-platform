import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiHeaders,
  consoleCookie,
  createSpace,
  startS4App,
  type S4AppHarness,
} from './s4-app-harness';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';

const runId = process.env.CODEXB_RUN_ID ?? `b13b-ui-${Date.now()}`;
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_b13b_${suffix}`;
const memberId = `b13b_member_${suffix}`;
const authToken = `b13b-token-${suffix}`;
const root = resolve(import.meta.dirname, '../..');
const resultDir = join(root, 'test-results', 'b13b', runId, 'e2e');

let app: S4AppHarness;
let browser: Browser;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;

async function api<T>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
  key = `b13b-ui-${randomUUID()}`,
) {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...apiHeaders({
        authToken,
        workspaceId,
        ...(method === 'GET' ? {} : { idempotencyKey: key }),
      }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json()) as {
    success: boolean;
    data?: T;
    error?: { code?: string };
  };
  return { status: response.status, payload };
}

async function createSource(spaceId: string, name: string) {
  const result = await api<{ id: string; sourceVersion: number; version: number }>(
    `/v1/knowledge/spaces/${spaceId}/sources`,
    'POST',
    { kind: 'text', name, searchEnabled: true, metadata: {} },
  );
  if (result.status !== 201 || !result.payload.data) {
    throw new Error(`createSource failed: ${JSON.stringify(result)}`);
  }
  return result.payload.data;
}

async function createParseJob(spaceId: string, sourceId: string, sourceVersion: number) {
  const result = await api<{ jobId: string; version: number }>('/v1/knowledge/jobs', 'POST', {
    kind: 'parse',
    resourceType: 'source',
    resourceId: sourceId,
    inputSnapshot: {
      sourceVersion,
      parseProvider: 'builtin',
      configHash: `b13b-ui-${suffix}`,
    },
    priority: 5,
  });
  if (result.status !== 202 || !result.payload.data) {
    throw new Error(`createParseJob failed: ${JSON.stringify(result)}`);
  }
  return result.payload.data;
}

async function newPage() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  });
  await context.addCookies([cookie]);
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return { context, page, consoleErrors, failedRequests };
}

async function capture(page: Page, name: string) {
  await page
    .screenshot({ path: join(resultDir, `${name}.png`), fullPage: true })
    .catch(() => undefined);
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_test?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/14';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-test';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';
  await mkdir(resultDir, { recursive: true });
  connection = await createKnowledgeMongoConnection(process.env.KB_TEST_MONGO_URI);
  await ensureKnowledgeCollections(connection);
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
  browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
}, 60_000);

describe('B13B product Job control UI', () => {
  it('L1-B13-B-TRAIN-005-UI01 exposes grouped training errors and row retry edit delete actions', async () => {
    const spaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
    const source = await createSource(spaceId, `B13B failed ${suffix}`);
    const job = await createParseJob(spaceId, source.id, source.sourceVersion);
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeSource.updateOne(
      { _id: source.id, workspaceId },
      { $set: { processingStatus: 'failed' } },
    );
    await models.KnowledgeJob.updateOne(
      { _id: job.jobId, workspaceId },
      {
        $set: {
          status: 'failed',
          error: { code: 'KNOWLEDGE_MODEL_FAILED', retryable: true },
          progress: { stage: 'parse', completed: 0, total: 1, percent: 0 },
        },
        $inc: { version: 1 },
      },
    );
    const { context, page, consoleErrors, failedRequests } = await newPage();
    try {
      await page.goto(`${app.baseUrl}/dataset/detail?datasetId=${spaceId}`, {
        waitUntil: 'networkidle',
      });
      const errorEntry = page.getByRole('button', { name: /异常列表/ });
      await playwrightExpect(errorEntry).toBeVisible();
      await errorEntry.click();
      await playwrightExpect(page.getByRole('dialog', { name: '训练与索引状态' })).toBeVisible();
      await page.waitForTimeout(350);
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect
        .soft(
          accessibility.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          ),
        )
        .toEqual([]);
      expect.soft(failedRequests).toEqual([]);
      expect.soft(consoleErrors).toEqual([]);
      await playwrightExpect.soft(page.getByRole('button', { name: '重试全部' })).toBeVisible();
      await playwrightExpect.soft(page.getByRole('button', { name: /编辑/ })).toBeVisible();
      await playwrightExpect.soft(page.getByRole('button', { name: /删除/ })).toBeVisible();
      await capture(page, 'L1-B13-B-TRAIN-005-UI01');
    } catch (error) {
      await capture(page, 'L1-B13-B-TRAIN-005-UI01');
      throw error;
    } finally {
      await context.close();
    }
  });

  it('L1-B13-B-TRAIN-007-UI01 exposes pause for running work and preserves it after refresh', async () => {
    const spaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
    const source = await createSource(spaceId, `B13B running ${suffix}`);
    const job = await createParseJob(spaceId, source.id, source.sourceVersion);
    const models = registerKnowledgeModels(connection);
    await models.KnowledgeSource.updateOne(
      { _id: source.id, workspaceId },
      { $set: { processingStatus: 'parsing' } },
    );
    await models.KnowledgeJob.updateOne(
      { _id: job.jobId, workspaceId },
      {
        $set: {
          status: 'running',
          leaseOwner: `b13b-ui-worker-${suffix}`,
          leaseExpiresAt: new Date(Date.now() + 300_000),
          heartbeatAt: new Date(),
          progress: { stage: 'parsing', completed: 1, total: 2, percent: 50 },
        },
        $inc: { version: 1 },
      },
    );
    const { context, page, consoleErrors, failedRequests } = await newPage();
    try {
      await page.goto(`${app.baseUrl}/dataset/detail?datasetId=${spaceId}`, {
        waitUntil: 'networkidle',
      });
      await page
        .getByRole('button', { name: `B13B running ${suffix} 的训练状态：内容解析中` })
        .click();
      await playwrightExpect(page.getByRole('dialog', { name: '训练与索引状态' })).toBeVisible();
      await playwrightExpect(page.getByRole('button', { name: '暂停' })).toBeVisible();
      await page.reload({ waitUntil: 'networkidle' });
      await playwrightExpect(page.getByText('内容解析中', { exact: true })).toBeVisible();
      expect(failedRequests).toEqual([]);
      expect(consoleErrors).toEqual([]);
    } catch (error) {
      await capture(page, 'L1-B13-B-TRAIN-007-UI01');
      throw error;
    } finally {
      await context.close();
    }
  });
});
