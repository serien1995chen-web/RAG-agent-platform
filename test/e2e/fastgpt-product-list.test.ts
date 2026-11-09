import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHeaders, consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_product_list_${suffix}`;
const memberId = `mem_product_list_${suffix}`;
const authToken = `kb-product-list-${suffix}`;
const resultDir = join(root, 'test-results', 'fastgpt-product-module1');

let app: S4AppHarness;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let folderId = '';
let nestedSpaceId = '';
let rootSpaceId = '';
let browser: Browser;

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
        idempotencyKey: method === 'GET' ? undefined : `product-${suffix}-${randomUUID()}`,
      }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json()) as {
    success?: boolean;
    data?: T;
    error?: { code?: string };
  };
  if (!response.ok || payload.success !== true) {
    throw new Error(`${method} ${path} failed: ${response.status} ${payload.error?.code ?? ''}`);
  }
  return payload.data as T;
}

async function createSpace(name: string, kind: 'space' | 'folder', parentSpaceId: string | null) {
  return api<{ id: string; version: number }>('/v1/knowledge/spaces', 'POST', {
    kind,
    parentSpaceId,
    name,
    description: `模块一验收 ${name}`,
    iconKey: kind === 'folder' ? 'folder' : 'book-open',
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
  });
}

async function deleteSpaceById(id: string) {
  const latest = await api<{ version: number; referenceRevision: number }>(
    `/v1/knowledge/spaces/${id}`,
    'GET',
  );
  await api(`/v1/knowledge/spaces/${id}`, 'DELETE', {
    version: latest.version,
    expectedReferenceRevision: latest.referenceRevision,
    referenceStrategy: 'block',
  });
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_product_list?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-local';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';

  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
  const folder = await createSpace(`模块一文件夹 ${suffix}`, 'folder', null);
  folderId = folder.id;
  const nested = await createSpace(`模块一子库 ${suffix}`, 'space', folderId);
  nestedSpaceId = nested.id;
  const rootSpace = await createSpace(`模块一根库 ${suffix}`, 'space', null);
  rootSpaceId = rootSpace.id;
  await mkdir(resultDir, { recursive: true });
  browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await deleteSpaceById(nestedSpaceId).catch(() => undefined);
  await deleteSpaceById(rootSpaceId).catch(() => undefined);
  await deleteSpaceById(folderId).catch(() => undefined);
  await app?.close();
}, 60_000);

describe('FastGPT product module 1 list', () => {
  it('renders real list data, excludes website, and keeps the layout desktop-safe', async () => {
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

    await page.goto(`${app.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
    await playwrightExpect(
      page.getByRole('heading', { level: 1, name: '我的知识库' }),
    ).toBeVisible();
    await playwrightExpect(page.getByText(`模块一文件夹 ${suffix}`, { exact: true })).toBeVisible();
    await playwrightExpect(page.getByText(`模块一根库 ${suffix}`, { exact: true })).toBeVisible();
    await playwrightExpect(page.getByText(`模块一子库 ${suffix}`, { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: '批量管理' }).click();
    await page.getByRole('checkbox', { name: `选择 模块一根库 ${suffix}` }).check();
    await playwrightExpect(page.getByText('已选择 1 个知识库')).toBeVisible();
    await page.getByRole('button', { name: '批量删除' }).click();
    await page.getByLabel('确认文本').fill(`模块一根库 ${suffix}`);
    await page.getByRole('button', { name: '确认删除' }).click();
    await playwrightExpect(page.getByText(`模块一根库 ${suffix}`, { exact: true })).toHaveCount(0);
    rootSpaceId = '';
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: join(resultDir, 'after-batch-delete.png'), fullPage: true });
    expect(page.url()).toContain('/dataset/list');
    expect(consoleErrors).toEqual([]);

    await page.getByRole('button', { name: '新建' }).click();
    await playwrightExpect(page.getByRole('menuitem', { name: /通用知识库/ })).toBeVisible();
    await playwrightExpect(page.getByRole('menuitem', { name: /网站知识库/ })).toHaveCount(0);
    await playwrightExpect(page.getByRole('menuitem', { name: /API 文件库/ })).toBeVisible();
    await playwrightExpect(page.getByRole('menuitem', { name: /飞书知识库/ })).toBeVisible();
    await playwrightExpect(page.getByRole('menuitem', { name: /语雀知识库/ })).toBeVisible();
    await playwrightExpect(page.getByRole('menuitem', { name: /钉钉知识库/ })).toBeVisible();
    await page.getByRole('button', { name: '关闭菜单' }).click();

    await page.getByRole('button', { name: `模块一文件夹 ${suffix} 文件夹` }).click();
    await page.waitForURL(`**/dataset/list?parentId=${folderId}`);
    await playwrightExpect(
      page.getByRole('heading', { level: 1, name: `模块一文件夹 ${suffix}` }),
    ).toBeVisible();
    await playwrightExpect(
      page.getByRole('heading', { level: 2, name: `模块一文件夹 ${suffix}` }),
    ).toBeVisible();
    await playwrightExpect(page.getByText(`模块一子库 ${suffix}`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '权限', exact: true }).click();
    await playwrightExpect(page.getByText('权限配置', { exact: true })).toBeVisible();
    await playwrightExpect(page.getByText(/ACL 状态：/)).toBeVisible();
    await page.getByRole('button', { name: '关闭弹窗' }).click();
    await playwrightExpect(page.locator('.kb2-modal')).toHaveCount(0);

    await page.getByLabel('搜索当前目录').fill('不存在');
    await playwrightExpect(
      page.getByRole('heading', { level: 3, name: '没有匹配的知识库' }),
    ).toBeVisible();
    await page.getByLabel('搜索当前目录').fill('');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
    expect(consoleErrors).toEqual([]);

    for (const width of [1200, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(100);
      const viewportOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(viewportOverflow, `${width}px horizontal overflow`).toBeLessThanOrEqual(1);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({
      path: join(resultDir, 'dataset-list-folder-1440.png'),
      fullPage: true,
    });
    await context.close();
  });

  it('creates and deletes a knowledge base through real APIs', async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const name = `模块一创建 ${suffix}`;
    await page.goto(`${app.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '新建' }).click();
    await page.getByRole('menuitem', { name: /通用知识库/ }).click();
    await page.locator('#kb2-create-form input').first().fill(name);
    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/v1/knowledge/spaces',
    );
    await page.getByRole('button', { name: '创建', exact: true }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);
    await page.waitForTimeout(500);
    expect(page.url()).toMatch(/\/dataset\/detail\?datasetId=/);
    await playwrightExpect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await playwrightExpect(page.getByRole('tab', { name: '数据集' })).toBeVisible();

    await page.getByRole('button', { name: '我的知识库' }).click();
    await page.waitForURL('**/dataset/list');
    await page.getByRole('button', { name: `${name} 的更多操作` }).click();
    await page.getByRole('menuitem', { name: '删除' }).click();
    await page.getByLabel('资源名称').fill(name);
    await page.getByRole('button', { name: '确认删除' }).click();
    await playwrightExpect(page.getByText(name, { exact: true })).toHaveCount(0);

    await context.close();
  });
});
