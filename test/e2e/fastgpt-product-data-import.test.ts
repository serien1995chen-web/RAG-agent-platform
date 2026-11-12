import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHeaders, consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeConnections } from '../../packages/service/src/shared/runtime/knowledge-connections';

const root = resolve(import.meta.dirname, '../..');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_product_data_${suffix}`;
const memberId = `mem_product_data_${suffix}`;
const authToken = `kb-product-data-${suffix}`;
const resultDir = join(root, 'test-results', 'fastgpt-product-module3');

let app: S4AppHarness;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let browser: Browser;
let connections: Awaited<ReturnType<typeof createKnowledgeConnections>>;
let models: ReturnType<typeof registerKnowledgeModels>;
let datasetId = '';
let sourceId = '';

async function api<T = Record<string, unknown>>(
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...apiHeaders({
        authToken,
        workspaceId,
        idempotencyKey: method === 'GET' ? undefined : `data-${suffix}-${randomUUID()}`,
      }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: { code?: string };
  };
  if (!response.ok || payload.success !== true) {
    throw new Error(`${method} ${path} failed: ${response.status} ${payload.error?.code ?? ''}`);
  }
  return payload.data as T;
}

async function seed() {
  const dataset = await api<{ id: string }>('/v1/knowledge/spaces', 'POST', {
    kind: 'space',
    parentSpaceId: null,
    name: `模块三知识库 ${suffix}`,
    description: '模块三 Data 与 Import 验收',
    iconKey: 'book-open',
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
  });
  datasetId = dataset.id;
  const source = await api<{ id: string }>(`/v1/knowledge/spaces/${datasetId}/sources`, 'POST', {
    kind: 'text',
    directoryId: null,
    name: `模块三文本源 ${suffix}`,
    searchEnabled: true,
    metadata: {},
  });
  sourceId = source.id;
  await api(`/v1/knowledge/sources/${sourceId}/segments`, 'POST', {
    question: '退款多久到账？\n\n退款通常会在五个工作日内到账。',
    answer: '退款通常会在五个工作日内到账。',
    searchEnabled: true,
    metadata: {},
  });
  await api(`/v1/knowledge/sources/${sourceId}/segments`, 'POST', {
    question: '如何联系人工客服？',
    answer: '可以在工作时间内联系人工客服。',
    searchEnabled: true,
    metadata: {},
  });
}

async function cleanup() {
  if (sourceId) {
    await api(`/v1/knowledge/sources/${sourceId}`, 'DELETE').catch(() => undefined);
  }
  if (datasetId) {
    const latest = await api<{ version: number; referenceRevision: number }>(
      `/v1/knowledge/spaces/${datasetId}`,
      'GET',
    ).catch(() => null);
    if (latest) {
      await api(`/v1/knowledge/spaces/${datasetId}`, 'DELETE', {
        version: latest.version,
        expectedReferenceRevision: latest.referenceRevision,
        referenceStrategy: 'block',
      }).catch(() => undefined);
    }
  }
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_product_data?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-local';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';

  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
  await seed();
  connections = await createKnowledgeConnections({
    environment: 'test',
    workerMode: 'http',
    port: 3010,
    instanceId: `product-data-fixture-${suffix}`,
    mongoUri: process.env.KB_TEST_MONGO_URI,
    redisUrl: process.env.KB_TEST_REDIS_URL,
    pgUrl: process.env.KB_TEST_PG_URL,
    s3: {
      endpoint: process.env.KB_TEST_S3_ENDPOINT,
      region: process.env.KB_TEST_S3_REGION,
      bucket: process.env.KB_TEST_S3_BUCKET,
      accessKeyRef: 'env:KB_PRODUCT_DATA_ACCESS',
      secretKeyRef: 'env:KB_PRODUCT_DATA_SECRET',
    },
    auth: {
      mode: 'mock',
      fixture: {
        token: authToken,
        workspaceId,
        memberId,
        scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
        isWorkspaceOwner: true,
      },
    },
    externalModes: { model: 'mock', ocr: 'mock', connector: 'mock' },
    logLevel: 'error',
  });
  models = registerKnowledgeModels(connections.mongo);
  await models.KnowledgeSegment.updateMany(
    { workspaceId, sourceId },
    { $set: { indexStatus: 'indexed', indexErrorCode: null } },
  );
  await mkdir(resultDir, { recursive: true });
  browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
  await cleanup();
  await connections?.close();
  await browser?.close();
  await app?.close();
}, 60_000);

describe('FastGPT product module 3 Data and Import', () => {
  it('renders Data cards, edits, creates and deletes segments through real APIs', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=dataCard&collectionId=${sourceId}`,
      { waitUntil: 'networkidle' },
    );
    await playwrightExpect(
      page.getByRole('heading', { level: 1, name: new RegExp(`模块三文本源 ${suffix}`) }),
    ).toBeVisible();
    await playwrightExpect(page.locator('.kb2-data-card')).toHaveCount(2);
    await playwrightExpect(page.getByText(/退款通常会在五个工作日内到账/).first()).toBeVisible();
    await playwrightExpect(page.getByText('元数据', { exact: true })).toBeVisible();
    await playwrightExpect(page.getByText(sourceId, { exact: true }).first()).toBeVisible();

    await page.getByLabel('搜索数据块').fill('人工客服');
    await playwrightExpect(page.locator('.kb2-data-card')).toHaveCount(1);
    await page.getByLabel('搜索数据块').fill('');
    await page.getByRole('button', { name: '编辑数据块 1' }).click();
    const editor = page.locator('.kb2-data-editor');
    await editor
      .locator('textarea')
      .first()
      .fill('退款多久到账？已更新\n\n退款通常会在五个工作日内到账。');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await playwrightExpect(page.getByText(/已更新/).first()).toBeVisible();

    await page.getByRole('button', { name: '插入', exact: true }).click();
    await page.locator('.kb2-modal .kb2-data-editor textarea').first().fill('新增验收数据');
    const createSegment = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/sources/${sourceId}/segments`),
    );
    await page.locator('.kb2-modal').getByRole('button', { name: '插入', exact: true }).click();
    const createSegmentResponse = await createSegment;
    if (createSegmentResponse.status() !== 201) {
      console.log('create-segment-failed', await createSegmentResponse.text());
      console.log('app-output', app.output());
    }
    expect(createSegmentResponse.status()).toBe(201);
    await playwrightExpect(page.locator('.kb2-data-card')).toHaveCount(3);
    await playwrightExpect(page.getByText('新增验收数据').first()).toBeVisible();

    await page.getByRole('button', { name: '导出分块' }).click();
    await playwrightExpect(page.getByText('后端能力未实现')).toBeVisible();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '调整训练参数' }).click();
    await page.waitForURL(/currentTab=import.*source=reTraining/);
    await playwrightExpect(page.getByText('重训练能力尚未实现')).toBeVisible();

    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=dataCard&collectionId=${sourceId}`,
      { waitUntil: 'networkidle' },
    );
    await page.getByRole('button', { name: '批量管理' }).click();
    await page
      .getByRole('checkbox', { name: /选择数据块/ })
      .first()
      .check();
    await page.getByRole('button', { name: '批量删除' }).click();
    await page.getByLabel('确认文本').fill('确认删除');
    await page.getByRole('button', { name: '确认删除' }).click();
    await playwrightExpect(page.locator('.kb2-data-card')).toHaveCount(2);

    for (const width of [1440, 1200, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(100);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${width}px horizontal overflow`).toBeLessThanOrEqual(1);
    }
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: join(resultDir, 'data-1440.png'), fullPage: true });
    await context.close();
  });

  it('imports custom text and a local file with real upload and Job state', async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=import&source=fileCustom`,
      { waitUntil: 'networkidle' },
    );
    await playwrightExpect(page.getByText('网站知识库')).toHaveCount(0);
    await page.getByRole('button', { name: /自定义文本/ }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByLabel('名称').fill(`手工导入 ${suffix}`);
    await page.getByLabel('文本内容').fill('这是一段通过真实导入 API 提交的文本。');
    await page.getByRole('button', { name: '下一步' }).click();
    await playwrightExpect(page.getByText('分块数量', { exact: true })).toBeVisible();
    await playwrightExpect(page.getByText('这是一段通过真实导入 API 提交的文本。')).toBeVisible();
    await page.getByRole('button', { name: '下一步' }).click();
    const textImport = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/spaces/${datasetId}/imports/text`),
    );
    await page.getByRole('button', { name: '确认导入' }).click();
    expect((await textImport).status()).toBe(202);
    await playwrightExpect(page.getByText('任务 ID')).toBeVisible();
    await playwrightExpect(page.getByText(/等待处理|处理中|已完成/).first()).toBeVisible();
    await page.waitForTimeout(3_500);
    for (const width of [1200, 900]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${width}px import overflow`).toBeLessThanOrEqual(1);
    }
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.screenshot({ path: join(resultDir, 'import-result-1200.png'), fullPage: true });

    await page.getByRole('button', { name: '返回 Collection' }).first().click();
    await page.getByRole('tab', { name: '数据集' }).click();
    await page.getByRole('button', { name: '新建 / 导入' }).click();
    await page.getByRole('button', { name: /本地文件/ }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: `模块三上传-${suffix}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from('真实上传文件内容', 'utf8'),
    });
    await playwrightExpect(
      page.getByText(`模块三上传-${suffix}.txt`, { exact: true }),
    ).toBeVisible();
    await playwrightExpect(page.getByText('completed', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    const fileImport = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/spaces/${datasetId}/imports/files`),
    );
    await page.getByRole('button', { name: '确认导入' }).click();
    expect((await fileImport).status()).toBe(202);
    await playwrightExpect(page.getByText('任务 ID')).toBeVisible();

    await context.close();
  });
});
