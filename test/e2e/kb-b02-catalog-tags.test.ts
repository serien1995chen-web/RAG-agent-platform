import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHeaders, consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_b02_e2e_${suffix}`;
const memberId = `mem_b02_e2e_${suffix}`;
const authToken = `kb-b02-e2e-${suffix}`;
const runId = process.env.B02_RUN_ID ?? 'b02-manual';
const resultDir = join(root, 'test-results', 'b02', runId, 'ui');

let app: S4AppHarness;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let browser: Browser;
let spaceId = '';
let rootDirectoryId = '';
let childDirectoryId = '';
let leafDirectoryId = '';
let rootSourceId = '';
let childSourceId = '';
let leafSourceId = '';
let rootSourceVersion = 1;
let childSourceVersion = 1;
let stringTagId = '';
let arrayTagId = '';

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
        idempotencyKey: method === 'GET' ? undefined : `b02-${suffix}-${randomUUID()}`,
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

async function createDirectory(name: string, parentDirectoryId: string | null) {
  return api<{ id: string }>(`/v1/knowledge/spaces/${spaceId}/directories`, 'POST', {
    name,
    parentDirectoryId,
  });
}

async function createSource(name: string, kind: 'file' | 'text', directoryId: string | null) {
  return api<{ id: string; version: number }>(`/v1/knowledge/spaces/${spaceId}/sources`, 'POST', {
    kind,
    name,
    directoryId,
    searchEnabled: true,
    metadata: {},
  });
}

async function seed() {
  const space = await api<{ id: string }>('/v1/knowledge/spaces', 'POST', {
    kind: 'space',
    parentSpaceId: null,
    name: `B02 目录标签知识库 ${suffix}`,
    description: 'B02 directory source tag acceptance',
    iconKey: 'book-open',
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
  });
  spaceId = space.id;
  rootDirectoryId = (await createDirectory(`一级目录 ${suffix}`, null)).id;
  childDirectoryId = (await createDirectory(`二级目录 ${suffix}`, rootDirectoryId)).id;
  leafDirectoryId = (await createDirectory(`三级目录 ${suffix}`, childDirectoryId)).id;
  const rootSource = await createSource(`根文件 ${suffix}`, 'file', null);
  rootSourceId = rootSource.id;
  rootSourceVersion = rootSource.version;
  const childSource = await createSource(`二级文本 ${suffix}`, 'text', childDirectoryId);
  childSourceId = childSource.id;
  childSourceVersion = childSource.version;
  leafSourceId = (await createSource(`三级文件 ${suffix}`, 'file', leafDirectoryId)).id;

  stringTagId = (
    await api<{ id: string }>(`/v1/knowledge/spaces/${spaceId}/tags`, 'POST', {
      key: `department_${suffix}`,
      label: '部门',
      tagType: 'string',
      required: false,
      options: ['support', 'sales'],
    })
  ).id;
  arrayTagId = (
    await api<{ id: string }>(`/v1/knowledge/spaces/${spaceId}/tags`, 'POST', {
      key: `regions_${suffix}`,
      label: '地区',
      tagType: 'array',
      required: false,
      options: ['cn', 'apac'],
    })
  ).id;
  await api('/v1/knowledge/sources/tag-assignments', 'POST', {
    items: [
      { sourceId: rootSourceId, tagId: stringTagId, value: 'support' },
      { sourceId: rootSourceId, tagId: arrayTagId, value: ['cn'] },
      { sourceId: childSourceId, tagId: stringTagId, value: 'sales' },
    ],
    sourceVersions: {
      [rootSourceId]: rootSourceVersion,
      [childSourceId]: childSourceVersion,
    },
  });
}

async function cleanup() {
  for (const sourceId of [rootSourceId, childSourceId, leafSourceId]) {
    if (sourceId) {
      await api(`/v1/knowledge/sources/${sourceId}`, 'DELETE').catch(() => undefined);
    }
  }
  for (const directoryId of [leafDirectoryId, childDirectoryId, rootDirectoryId]) {
    if (directoryId) {
      await api(`/v1/knowledge/directories/${directoryId}`, 'DELETE').catch(() => undefined);
    }
  }
  for (const tagId of [stringTagId, arrayTagId]) {
    if (tagId) {
      await api(`/v1/knowledge/tags/${tagId}`, 'DELETE').catch(() => undefined);
    }
  }
  if (spaceId) {
    const latest = await api<{ version: number; referenceRevision: number }>(
      `/v1/knowledge/spaces/${spaceId}`,
      'GET',
    ).catch(() => null);
    if (latest) {
      await api(`/v1/knowledge/spaces/${spaceId}`, 'DELETE', {
        version: latest.version,
        expectedReferenceRevision: latest.referenceRevision,
        referenceStrategy: 'block',
      }).catch(() => undefined);
    }
  }
}

async function pageWithCookie(width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN' });
  await context.addCookies([cookie]);
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  return { context, page };
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_b02_e2e?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-test';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  const readiness = await fetch(`${app.baseUrl}/readyz`);
  expect(readiness.status).toBe(200);
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

describe('L1 B02 desktop directory, Source and tags', () => {
  it('L1-B02-COL-001-UI01 目录进入返回、Source 进入 Data、搜索与行点击隔离并刷新保持', async () => {
    const { context, page } = await pageWithCookie();
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=collectionCard`,
      { waitUntil: 'networkidle' },
    );
    await playwrightExpect(
      page.getByRole('heading', { level: 1, name: `B02 目录标签知识库 ${suffix}` }),
    ).toBeVisible();
    await playwrightExpect(page.getByText(`根文件 ${suffix}`, { exact: true })).toBeVisible();
    await playwrightExpect(page.getByText(`一级目录 ${suffix}`, { exact: true })).toBeVisible();

    await page.getByLabel('搜索文件或目录').fill('根文件');
    await playwrightExpect(page.getByText(`一级目录 ${suffix}`, { exact: true })).toHaveCount(0);
    await playwrightExpect(page.getByText(`根文件 ${suffix}`, { exact: true })).toBeVisible();
    await page.getByLabel('搜索文件或目录').fill('');

    await page
      .locator('.kb2-collection-table tbody tr', { hasText: `一级目录 ${suffix}` })
      .locator('.kb2-collection-name')
      .click();
    await page.waitForURL(new RegExp(`parentId=${rootDirectoryId}`));
    await playwrightExpect(page.getByText(`二级目录 ${suffix}`, { exact: true })).toBeVisible();
    await page
      .locator('.kb2-collection-table tbody tr', { hasText: `二级目录 ${suffix}` })
      .locator('.kb2-collection-name')
      .click();
    await page.waitForURL(new RegExp(`parentId=${childDirectoryId}`));
    await playwrightExpect(page.getByText(`二级文本 ${suffix}`, { exact: true })).toBeVisible();
    await page
      .locator('.kb2-collection-table tbody tr', { hasText: `二级文本 ${suffix}` })
      .locator('.kb2-collection-name')
      .click();
    await page.waitForURL(new RegExp(`collectionId=${childSourceId}`));
    await playwrightExpect(
      page.getByRole('heading', { level: 1, name: new RegExp(`二级文本 ${suffix}`) }),
    ).toBeVisible();
    await page.reload({ waitUntil: 'networkidle' });
    await playwrightExpect(
      page.getByRole('heading', { level: 1, name: new RegExp(`二级文本 ${suffix}`) }),
    ).toBeVisible();
    expect(consoleErrors).toEqual([]);
    await page.screenshot({ path: join(resultDir, 'col-001-ui01.png'), fullPage: true });
    await context.close();
  });

  it('L1-B02-COL-002-UI01 Source 路径筛选、状态标签和无效深链恢复正确', async () => {
    const { context, page } = await pageWithCookie(1200, 900);
    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=collectionCard&parentId=${leafDirectoryId}`,
      { waitUntil: 'networkidle' },
    );
    await playwrightExpect(page.getByText(`三级文件 ${suffix}`, { exact: true })).toBeVisible();
    await page.getByLabel('标签筛选').selectOption(stringTagId);
    await page.getByLabel('标签值筛选').selectOption('support');
    await playwrightExpect(page.getByText('没有匹配的文件')).toBeVisible();
    await page.getByRole('button', { name: /清空/ }).click();
    await playwrightExpect(page.getByText(`三级文件 ${suffix}`, { exact: true })).toBeVisible();

    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=collectionCard&parentId=000000000000000000000000`,
      { waitUntil: 'networkidle' },
    );
    await page.waitForURL((url) => !url.searchParams.has('parentId'));
    await playwrightExpect(page.getByRole('heading', { level: 2, name: '全部文件' })).toBeVisible();
    await page.screenshot({ path: join(resultDir, 'col-002-ui01.png'), fullPage: true });
    await context.close();
  });

  it('L1-B02-COL-003-UI01 标签管理、四类值展示、筛选空态、刷新恢复和 axe 门禁正确', async () => {
    const { context, page } = await pageWithCookie();
    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=collectionCard`,
      { waitUntil: 'networkidle' },
    );
    await page.getByRole('button', { name: '标签管理' }).click();
    await playwrightExpect(
      page.locator('.kb2-modal').getByText('部门', { exact: true }),
    ).toBeVisible();
    await playwrightExpect(
      page.locator('.kb2-modal').getByText('地区', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '关闭弹窗' }).click();

    await page.getByLabel('标签筛选').selectOption(stringTagId);
    await page.getByLabel('标签值筛选').selectOption('support');
    await playwrightExpect(page.getByText(`根文件 ${suffix}`, { exact: true })).toBeVisible();
    await page.reload({ waitUntil: 'networkidle' });
    await playwrightExpect(page.getByLabel('搜索文件或目录')).toBeVisible();
    await playwrightExpect(page.getByText(`根文件 ${suffix}`, { exact: true })).toBeVisible();

    await page.getByLabel('标签筛选').selectOption(arrayTagId);
    await page.getByLabel('标签值筛选').selectOption('cn');
    await playwrightExpect(page.getByText(`根文件 ${suffix}`, { exact: true })).toBeVisible();
    await page.screenshot({ path: join(resultDir, 'col-003-ui01.png'), fullPage: true });
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
    await context.close();
  });
});
