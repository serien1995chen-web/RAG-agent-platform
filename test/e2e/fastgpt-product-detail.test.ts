import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHeaders, consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_product_detail_${suffix}`;
const memberId = `mem_product_detail_${suffix}`;
const authToken = `kb-product-detail-${suffix}`;
const resultDir = join(root, 'test-results', 'fastgpt-product-module2');

let app: S4AppHarness;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let browser: Browser;
let datasetId = '';
let directoryId = '';
let rootSourceOneId = '';
let rootSourceTwoId = '';
let directorySourceId = '';
let tagId = '';

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
        idempotencyKey: method === 'GET' ? undefined : `detail-${suffix}-${randomUUID()}`,
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
    name: `模块二知识库 ${suffix}`,
    description: '模块二真实 Collection 验收',
    iconKey: 'book-open',
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
  });
  datasetId = dataset.id;
  const directory = await api<{ id: string }>(
    `/v1/knowledge/spaces/${datasetId}/directories`,
    'POST',
    { name: `模块二目录 ${suffix}`, parentDirectoryId: null },
  );
  directoryId = directory.id;
  const rootOne = await api<{ id: string }>(`/v1/knowledge/spaces/${datasetId}/sources`, 'POST', {
    kind: 'text',
    directoryId: null,
    name: `客服手册 ${suffix}`,
    searchEnabled: true,
    metadata: {},
  });
  rootSourceOneId = rootOne.id;
  const rootTwo = await api<{ id: string }>(`/v1/knowledge/spaces/${datasetId}/sources`, 'POST', {
    kind: 'file',
    directoryId: null,
    name: `销售手册 ${suffix}`,
    searchEnabled: true,
    metadata: {},
  });
  rootSourceTwoId = rootTwo.id;
  const nested = await api<{ id: string }>(`/v1/knowledge/spaces/${datasetId}/sources`, 'POST', {
    kind: 'url',
    directoryId,
    name: `子目录网页 ${suffix}`,
    searchEnabled: true,
    metadata: {},
  });
  directorySourceId = nested.id;
  const tag = await api<{ id: string }>(`/v1/knowledge/spaces/${datasetId}/tags`, 'POST', {
    key: `department_${suffix}`,
    label: '部门',
    tagType: 'array',
    required: false,
    options: ['support', 'sales'],
  });
  tagId = tag.id;
  await api('/v1/knowledge/sources/tag-assignments', 'POST', {
    items: [{ sourceId: rootSourceOneId, tagId, value: ['support'] }],
  });
  const seededSources = await api<{
    items: Array<{
      id: string;
      tagValues?: Array<{ tagId: string; valueKey: string; value: unknown }>;
    }>;
  }>(`/v1/knowledge/spaces/${datasetId}/sources`, 'GET');
  expect(seededSources.items.find((source) => source.id === rootSourceOneId)?.tagValues).toEqual([
    { tagId, valueKey: 'support', value: ['support'] },
  ]);
}

async function cleanup() {
  for (const sourceId of [rootSourceOneId, rootSourceTwoId, directorySourceId]) {
    if (sourceId) {
      await api(`/v1/knowledge/sources/${sourceId}`, 'DELETE').catch(() => undefined);
    }
  }
  if (directoryId) {
    await api(`/v1/knowledge/directories/${directoryId}`, 'DELETE').catch(() => undefined);
  }
  if (tagId) {
    await api(`/v1/knowledge/tags/${tagId}`, 'DELETE').catch(() => undefined);
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
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_product_detail?replicaSet=rs0';
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
  await mkdir(resultDir, { recursive: true });
  browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
  await cleanup();
  await browser?.close();
  await app?.close();
}, 60_000);

describe('FastGPT product module 2 detail and collection', () => {
  it('keeps URL context, filters sources, navigates directories and shows real permissions', async () => {
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
      `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=collectionCard`,
      { waitUntil: 'networkidle' },
    );
    await playwrightExpect(
      page.getByRole('heading', { level: 1, name: `模块二知识库 ${suffix}` }),
    ).toBeVisible();
    await playwrightExpect(page.getByRole('tab', { name: '数据集' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await playwrightExpect(page.getByRole('tab', { name: '搜索测试' })).toBeVisible();
    await playwrightExpect(page.getByRole('heading', { level: 2, name: '全部文件' })).toBeVisible();
    await playwrightExpect(page.getByText(`客服手册 ${suffix}`, { exact: true })).toBeVisible();
    await playwrightExpect(page.getByText(`销售手册 ${suffix}`, { exact: true })).toBeVisible();
    await playwrightExpect(page.getByText(`子目录网页 ${suffix}`, { exact: true })).toHaveCount(0);
    await playwrightExpect(page.getByText(`知识库 ID`)).toBeVisible();
    await playwrightExpect(page.getByText(datasetId, { exact: true })).toBeVisible();

    await page.getByLabel('搜索文件或目录').fill('客服');
    await playwrightExpect(page.getByText(`客服手册 ${suffix}`, { exact: true })).toBeVisible();
    await playwrightExpect(page.getByText(`销售手册 ${suffix}`, { exact: true })).toHaveCount(0);
    await page.getByLabel('搜索文件或目录').fill('');
    await page.getByLabel('标签筛选').selectOption(tagId);
    await page.getByLabel('标签值筛选').selectOption('support');
    await playwrightExpect(page.getByText(`客服手册 ${suffix}`, { exact: true })).toBeVisible();
    await playwrightExpect(page.getByText(`销售手册 ${suffix}`, { exact: true })).toHaveCount(0);
    await page.getByLabel('标签筛选').selectOption('');

    await page
      .locator('.kb2-collection-table tbody tr', { hasText: `模块二目录 ${suffix}` })
      .locator('.kb2-collection-name')
      .click();
    await page.waitForURL(new RegExp(`parentId=${directoryId}`));
    await playwrightExpect(
      page.getByRole('heading', { level: 1, name: `模块二知识库 ${suffix}` }),
    ).toBeVisible();
    await playwrightExpect(
      page.getByRole('heading', { level: 2, name: `模块二目录 ${suffix}` }).first(),
    ).toBeVisible();
    await playwrightExpect(page.getByText(`子目录网页 ${suffix}`, { exact: true })).toBeVisible();
    await playwrightExpect(page.getByText(`客服手册 ${suffix}`, { exact: true })).toHaveCount(0);

    await page
      .locator('.kb2-collection-table tbody tr', { hasText: `子目录网页 ${suffix}` })
      .locator('.kb2-collection-name')
      .click();
    await page.waitForURL(new RegExp(`currentTab=dataCard.*collectionId=${directorySourceId}`));
    await playwrightExpect(
      page.getByRole('heading', { level: 1, name: new RegExp(`子目录网页 ${suffix}`) }),
    ).toBeVisible();
    await playwrightExpect(page.getByText('这个集合还没有数据')).toBeVisible();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await playwrightExpect(
      page.getByRole('heading', { level: 2, name: `模块二目录 ${suffix}` }).first(),
    ).toBeVisible();

    await page.getByRole('button', { name: '标签管理' }).click();
    await playwrightExpect(
      page.locator('.kb2-modal').getByText('部门', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '关闭弹窗' }).click();
    await playwrightExpect(page.locator('.kb2-modal')).toHaveCount(0);

    await page.getByRole('button', { name: `子目录网页 ${suffix} 的更多操作` }).click();
    await page.getByRole('menuitem', { name: 'Source 权限' }).click();
    await playwrightExpect(page.getByText('权限配置', { exact: true })).toBeVisible();
    await playwrightExpect(page.getByText(/ACL：/)).toBeVisible();
    await page.getByRole('button', { name: '关闭弹窗' }).click();
    await playwrightExpect(page.locator('.kb2-modal')).toHaveCount(0);

    await page.getByRole('tab', { name: '数据集', exact: true }).click();
    await page.getByRole('button', { name: '批量管理' }).click();
    await page.getByRole('checkbox', { name: `选择 销售手册 ${suffix}` }).check();
    await page.getByRole('button', { name: '批量删除' }).click();
    await page.getByLabel('确认文本').fill(`销售手册 ${suffix}`);
    await page.getByRole('button', { name: '确认删除' }).click();
    await playwrightExpect(page.getByText(`销售手册 ${suffix}`, { exact: true })).toHaveCount(0);
    await playwrightExpect(page.locator('.kb2-status-button').first()).toHaveAccessibleName(
      /训练状态：/,
    );

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
    await page.screenshot({
      path: join(resultDir, 'collection-1440.png'),
      fullPage: true,
    });
    await context.close();
  });

  it('keeps valid Collection and Search deep links and rejects invalid parents', async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);

    await page.goto(`${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=test`, {
      waitUntil: 'networkidle',
    });
    await playwrightExpect(page.getByRole('tab', { name: '搜索测试' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await playwrightExpect(page.getByLabel('测试查询')).toBeVisible();
    await playwrightExpect(page.getByText('测试结果将在这里展示')).toBeVisible();
    await playwrightExpect(page.getByText(`知识库 ID`)).toBeVisible();

    await page.goto(`${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=not-a-tab`, {
      waitUntil: 'networkidle',
    });
    await page.waitForURL(/currentTab=collectionCard/);
    await playwrightExpect(page.getByRole('heading', { level: 2, name: '全部文件' })).toBeVisible();

    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=collectionCard&parentId=000000000000000000000000`,
      { waitUntil: 'networkidle' },
    );
    await page.waitForURL((url) => !url.searchParams.has('parentId'));
    await playwrightExpect(page.getByRole('heading', { level: 2, name: '全部文件' })).toBeVisible();

    await context.close();
  });
});
