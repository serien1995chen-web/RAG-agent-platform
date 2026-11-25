import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import {
  chromium,
  expect as playwrightExpect,
  type Browser,
  type Page,
  type Route,
} from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeConnections } from '../../packages/service/src/shared/runtime/knowledge-connections';
import { apiHeaders, consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const resultDir = join(root, 'test-results', 'fastgpt-parity-012-021');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_parity_012_021_${suffix}`;
const ownerMemberId = `mem_parity_012_owner_${suffix}`;
const ownerToken = `parity-012-owner-${suffix}`;
const roles = ['read', 'write', 'manage'] as const;
type Role = (typeof roles)[number] | 'owner';
const members: Record<Role, string> = {
  owner: ownerMemberId,
  read: `mem_parity_012_read_${suffix}`,
  write: `mem_parity_012_write_${suffix}`,
  manage: `mem_parity_012_manage_${suffix}`,
};
const tokens: Record<Role, string> = {
  owner: ownerToken,
  read: `parity-012-read-${suffix}`,
  write: `parity-012-write-${suffix}`,
  manage: `parity-012-manage-${suffix}`,
};

let ownerApp: S4AppHarness;
const roleApps: Partial<Record<Role, S4AppHarness>> = {};
let ownerCookie: Awaited<ReturnType<typeof consoleCookie>>;
const roleCookies: Partial<Record<Role, Awaited<ReturnType<typeof consoleCookie>>>> = {};
let browser: Browser;
let connections: Awaited<ReturnType<typeof createKnowledgeConnections>>;
let spaceId = '';
const sourceIds: string[] = [];

async function ownerApi<T = Record<string, unknown>>(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${ownerApp.baseUrl}${path}`, {
    method,
    headers: {
      ...apiHeaders({
        authToken: ownerToken,
        workspaceId,
        idempotencyKey: method === 'GET' ? undefined : `parity-012-${suffix}-${randomUUID()}`,
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
    throw new Error(`${method} ${path}: ${response.status} ${payload.error?.code ?? ''}`);
  }
  return payload.data as T;
}

async function newPage(
  cookie: Awaited<ReturnType<typeof consoleCookie>>,
  app: S4AppHarness,
  width = 1440,
) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    locale: 'zh-CN',
  });
  await context.addCookies([cookie]);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  return { context, page, baseUrl: app.baseUrl };
}

async function seed() {
  const space = await ownerApi<{ id: string; version: number; autoSync: boolean }>(
    '/v1/knowledge/spaces',
    'POST',
    {
      kind: 'space',
      parentSpaceId: null,
      name: `FastGPT 012-021 ${suffix}`,
      description: '参数、预览、同步、标签与文件菜单对照',
      iconKey: 'book-open',
      accessMode: 'workspace',
      sourceAclMode: 'inherited',
      sourcePermissionEnabled: true,
    },
  );
  spaceId = space.id;
  expect(space.autoSync).toBe(false);
  await ownerApi(`/v1/knowledge/spaces/${spaceId}/tags`, 'POST', {
    key: `legacy_${suffix.slice(0, 8)}`,
    label: '历史文本标签',
    tagType: 'string',
    required: false,
    options: [],
  });
  for (let index = 1; index <= 18; index += 1) {
    const source = await ownerApi<{ id: string; version: number }>(
      `/v1/knowledge/spaces/${spaceId}/sources`,
      'POST',
      {
        kind: 'text',
        directoryId: null,
        name: `菜单测试文件 ${String(index).padStart(2, '0')} ${suffix}`,
        searchEnabled: true,
        metadata: {},
      },
    );
    sourceIds.push(source.id);
  }
  await ownerApi(`/v1/knowledge/sources/${sourceIds[0]}/segments`, 'POST', {
    question: '退款多久到账？',
    answer: '退款通常会在五个工作日内到账。',
    searchEnabled: true,
    metadata: {},
  });
  for (const role of roles) {
    await ownerApi(`/v1/knowledge/spaces/${spaceId}/collaborators`, 'POST', {
      memberId: members[role],
      role,
    });
  }
}

async function cleanup() {
  if (!spaceId) return;
  const current = await ownerApi<{ version: number; referenceRevision: number }>(
    `/v1/knowledge/spaces/${spaceId}`,
    'GET',
  ).catch(() => null);
  if (!current) return;
  await ownerApi(`/v1/knowledge/spaces/${spaceId}`, 'DELETE', {
    version: current.version,
    expectedReferenceRevision: current.referenceRevision,
    referenceStrategy: 'block',
  }).catch(() => undefined);
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: join(resultDir, `${name}.png`), fullPage: true });
}

async function openLocalParameters(
  page: Page,
  baseUrl: string,
  files = [
    { name: `来源一-${suffix}.txt`, text: '第一段内容。\n\n第二段内容。\n\n第三段内容。' },
    { name: `来源二-${suffix}.txt`, text: '另一个文件的真实分块预览内容。' },
  ],
) {
  await page.goto(`${baseUrl}/dataset/detail?datasetId=${spaceId}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /新建\s*\/\s*导入/ }).click();
  await page.getByRole('menuitem', { name: /文本数据集/ }).click();
  const sourceDialog = page.getByRole('dialog', { name: /选择来源/ });
  await sourceDialog.getByRole('radio', { name: /本地文件/ }).check();
  await sourceDialog.getByRole('button', { name: '确认', exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(
    files.map((file) => ({
      name: file.name,
      mimeType: 'text/plain',
      buffer: Buffer.from(file.text, 'utf8'),
    })),
  );
  await playwrightExpect(page.getByText('上传完成', { exact: true })).toHaveCount(2, {
    timeout: 30_000,
  });
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  return page.locator('.kb2-import-settings');
}

async function openRowMenu(page: Page, source: string) {
  const row = page.getByRole('row').filter({ hasText: source }).first();
  await row.getByRole('button', { name: /更多操作/ }).click();
  const menu = page.locator('#kb2-product-menu');
  await playwrightExpect(menu).toBeVisible();
  return menu;
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??=
    'mongodb://127.0.0.1:27017/kb_fastgpt_parity_012_021?replicaSet=rs0&directConnection=true';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-local';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';
  await mkdir(resultDir, { recursive: true });

  ownerApp = await startS4App({
    suffix: `parity-012-owner-${suffix}`,
    workspaceId,
    memberId: ownerMemberId,
    authToken: ownerToken,
  });
  ownerCookie = await consoleCookie({
    baseUrl: ownerApp.baseUrl,
    authToken: ownerToken,
    workspaceId,
  });
  const scopeByRole: Record<(typeof roles)[number], string> = {
    read: 'knowledge:read',
    write: 'knowledge:read,knowledge:write',
    manage: 'knowledge:read,knowledge:write,knowledge:manage',
  };
  for (const role of roles) {
    const app = await startS4App({
      suffix: `parity-012-${role}-${suffix}`,
      workspaceId,
      memberId: members[role],
      authToken: tokens[role],
      scopes: scopeByRole[role],
      isWorkspaceOwner: false,
    });
    roleApps[role] = app;
    roleCookies[role] = await consoleCookie({
      baseUrl: app.baseUrl,
      authToken: tokens[role],
      workspaceId,
    });
  }
  await seed();
  connections = await createKnowledgeConnections({
    environment: 'test',
    workerMode: 'http',
    port: 3010,
    instanceId: `parity-012-021-${suffix}`,
    mongoUri: process.env.KB_TEST_MONGO_URI,
    redisUrl: process.env.KB_TEST_REDIS_URL,
    pgUrl: process.env.KB_TEST_PG_URL,
    s3: {
      endpoint: process.env.KB_TEST_S3_ENDPOINT,
      region: process.env.KB_TEST_S3_REGION,
      bucket: process.env.KB_TEST_S3_BUCKET,
      accessKeyRef: 'env:KB_PARITY_012_ACCESS',
      secretKeyRef: 'env:KB_PARITY_012_SECRET',
    },
    auth: {
      mode: 'mock',
      fixture: {
        token: ownerToken,
        workspaceId,
        memberId: ownerMemberId,
        scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage', 'knowledge:admin'],
        isWorkspaceOwner: true,
      },
    },
    externalModes: { model: 'mock', ocr: 'mock', connector: 'mock' },
    logLevel: 'error',
  });
  const models = registerKnowledgeModels(connections.mongo);
  await models.KnowledgeSource.updateMany(
    { workspaceId, _id: { $in: sourceIds } },
    { $set: { processingStatus: 'ready' } },
  );
  await models.KnowledgeSegment.updateMany(
    { workspaceId, sourceId: sourceIds[0] },
    { $set: { indexStatus: 'indexed', fullTextTokens: '退款 到账 工作日' } },
  );
  browser = await chromium.launch({ headless: true });
}, 240_000);

afterAll(async () => {
  await cleanup();
  await connections?.close();
  await browser?.close();
  await Promise.all(Object.values(roleApps).map((app) => app?.close().catch(() => undefined)));
  await ownerApp?.close();
}, 120_000);

describe('FastGPT knowledge parity KB-PARITY-012 through 021', () => {
  it('aligns processing parameters, scheduled sync and local chunk preview', async () => {
    const { context, page, baseUrl } = await newPage(ownerCookie, ownerApp);
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.goto(`${baseUrl}/dataset/detail?datasetId=${spaceId}`, {
      waitUntil: 'networkidle',
    });
    const info = page.getByRole('complementary', { name: '知识库信息' });
    await playwrightExpect(info.getByText('定时同步', { exact: true })).toBeVisible();
    for (const removed of ['数据源同步', '管理连接器', '立即同步']) {
      await playwrightExpect(info.getByText(removed, { exact: true })).toHaveCount(0);
    }
    await info.getByRole('switch', { name: '定时同步' }).click();
    const syncDialog = page.getByRole('dialog', { name: '开启定时同步' });
    await playwrightExpect(syncDialog).toBeVisible();
    await syncDialog.getByRole('button', { name: '取消' }).click();

    await page.getByRole('button', { name: '标签管理', exact: true }).click();
    let tagDialog = page.getByRole('dialog').filter({ hasText: '标签管理' });
    await playwrightExpect(tagDialog.getByText('历史文本标签')).toBeVisible();
    await playwrightExpect(tagDialog.getByText('字符串', { exact: true })).toBeVisible();
    await tagDialog.getByRole('button', { name: /添加标签/ }).click();
    const typeOptions = await tagDialog
      .getByLabel('新标签属性')
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(typeOptions).toEqual(['array', 'number', 'datetime']);
    await tagDialog.getByLabel('新标签名称').fill('来源渠道');
    await tagDialog.getByRole('button', { name: '保存新标签' }).click();
    await playwrightExpect(tagDialog.getByText('来源渠道')).toBeVisible();
    await tagDialog.getByRole('button', { name: '管理 来源渠道 的选项' }).click();
    const optionDialog = page.getByRole('dialog', { name: /管理选项/ });
    await optionDialog.getByRole('button', { name: /添加选项/ }).click();
    await optionDialog.getByRole('textbox', { name: '选项 1' }).fill('华东,中心');
    await optionDialog.getByRole('button', { name: /添加选项/ }).click();
    await optionDialog.getByRole('textbox', { name: '选项 2' }).fill('华南');
    await optionDialog.getByRole('button', { name: '保存' }).click();
    await playwrightExpect(page.getByText('标签选项已更新')).toBeVisible();
    await playwrightExpect(optionDialog).toHaveCount(0);
    tagDialog = page.getByRole('dialog').filter({ hasText: '标签管理' });
    const overflow = await tagDialog.locator('.kb2-tag-table-wrap').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    await screenshot(page, 'tag-manager-1440');
    await tagDialog.getByRole('button', { name: '关闭弹窗' }).click();

    const settings = await openLocalParameters(page, baseUrl);
    await playwrightExpect(settings.getByText('文件解析设置', { exact: true })).toBeVisible();
    await playwrightExpect(settings.getByText('数据处理方式设置', { exact: true })).toBeVisible();
    for (const removed of ['训练参数', '智能', '解析器', '凭据配置', '最小分块长度', '重叠长度']) {
      await playwrightExpect(settings.getByText(removed, { exact: true })).toHaveCount(0);
    }
    await settings.getByLabel('分块条件', { exact: true }).selectOption('forceChunk');
    await playwrightExpect(settings.getByLabel('分块条件值')).toHaveCount(0);
    await settings.getByRole('radio', { name: /自定义/ }).check();
    await playwrightExpect(settings.getByLabel('最大段落深度')).toHaveAttribute('max', '8');
    const indexOptions = await settings
      .getByLabel('索引大小')
      .locator('option')
      .evaluateAll((options) =>
        options.map((option) => Number((option as HTMLOptionElement).value)),
      );
    expect(indexOptions).toContain(512);
    expect(Math.max(...indexOptions)).toBeLessThanOrEqual(8192);
    await screenshot(page, 'import-parameters-custom');
    await page.getByRole('button', { name: '下一步', exact: true }).click();

    const preview = page.locator('.kb2-local-file-preview');
    await playwrightExpect(preview.getByText('文件列表', { exact: true })).toBeVisible();
    await playwrightExpect(preview.getByText('分块预览', { exact: true })).toBeVisible();
    await playwrightExpect(preview.getByText('尚未选择文件')).toBeVisible();
    let releasePreview = () => undefined;
    const previewGate = new Promise<void>((resolveGate) => {
      releasePreview = resolveGate;
    });
    await page.route('**/v1/knowledge/spaces/*/imports/files', async (route) => {
      if (route.request().postDataJSON()?.dryRun === true) await previewGate;
      await route.continue();
    });
    await preview.getByRole('option', { name: new RegExp(`来源一-${suffix}`) }).click();
    await playwrightExpect(preview.getByText(/正在解析并生成分块/)).toBeVisible();
    releasePreview();
    await playwrightExpect(preview.locator('.kb2-chunk-preview').first()).toBeVisible();
    await preview.getByRole('option', { name: new RegExp(`来源二-${suffix}`) }).click();
    await playwrightExpect(
      preview.getByRole('option', { name: new RegExp(`来源二-${suffix}`) }),
    ).toHaveAttribute('aria-selected', 'true');
    await screenshot(page, 'local-file-preview');
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await context.close();
  }, 240_000);

  it('aligns search loading, empty, error and history recovery states', async () => {
    const { context, page, baseUrl } = await newPage(ownerCookie, ownerApp);
    await page.goto(`${baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=test`, {
      waitUntil: 'networkidle',
    });
    await page.getByLabel('测试查询').fill('退款多久到账');
    let releaseSearch = () => undefined;
    const searchGate = new Promise<void>((resolveGate) => {
      releaseSearch = resolveGate;
    });
    await page.route('**/v1/knowledge/search/**', async (route) => {
      await searchGate;
      await route.continue();
    });
    const searchResponse = page
      .waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().includes('/v1/knowledge/search/'),
      )
      .catch(() => null);
    await page.getByRole('button', { name: '测试', exact: true }).click();
    const submit = page.locator('.kb2-search-submit');
    await playwrightExpect(submit).toHaveAttribute('aria-busy', 'true');
    await playwrightExpect(submit).toContainText('测试中');
    releaseSearch();
    expect((await searchResponse)?.status()).toBe(200);
    await page.unroute('**/v1/knowledge/search/**');

    await page.getByLabel('测试查询').fill(`不存在的查询 ${suffix}`);
    const emptyResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().includes('/v1/knowledge/search/'),
    );
    await page.getByRole('button', { name: '测试', exact: true }).click();
    await emptyResponse;
    await playwrightExpect(page.getByText(/搜索结果为空/)).toBeVisible();

    const failureHandler = async (route: Route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: {
            code: 'KNOWLEDGE_INTERNAL_ERROR',
            message: 'parity search failure',
            retryable: true,
            details: {},
          },
          traceId: `trace-${suffix}`,
          requestId: `request-${suffix}`,
        }),
      });
    };
    await page.route('**/v1/knowledge/search/**', failureHandler);
    await page.getByRole('button', { name: '测试', exact: true }).click();
    await playwrightExpect(page.getByRole('alert').first()).toBeVisible();
    const retryPage = await context.newPage();
    await retryPage.goto(`${baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=test`, {
      waitUntil: 'networkidle',
    });
    await retryPage.getByLabel('测试查询').fill('退款多久到账');
    const recovery = retryPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().includes('/v1/knowledge/search/'),
    );
    await retryPage.getByRole('button', { name: '测试', exact: true }).click();
    expect((await recovery).status()).toBe(200);
    await screenshot(retryPage, 'search-recovered');
    await context.close();
  }, 180_000);

  it('aligns source-menu permissions, clipping and keyboard behavior', async () => {
    const { context, page, baseUrl } = await newPage(ownerCookie, ownerApp);
    await page.goto(`${baseUrl}/dataset/detail?datasetId=${spaceId}`, {
      waitUntil: 'networkidle',
    });
    const wrapper = page.locator('.kb2-collection-table-wrap');
    await wrapper.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    const targetName = `菜单测试文件 01 ${suffix}`;
    let menu = await openRowMenu(page, targetName);
    await playwrightExpect(menu.getByRole('menuitem')).toHaveText([
      '移动',
      '重命名',
      '权限',
      '标签设置',
      '删除',
    ]);
    const layout = await page.evaluate(() => {
      const menuElement = document.querySelector<HTMLElement>('#kb2-product-menu');
      if (!menuElement) return null;
      const rect = menuElement.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        left: rect.left,
        right: rect.right,
      };
    });
    expect(layout).not.toBeNull();
    expect(layout!.top).toBeGreaterThanOrEqual(0);
    expect(layout!.bottom).toBeLessThanOrEqual(layout!.viewportHeight);
    expect(layout!.left).toBeGreaterThanOrEqual(0);
    expect(layout!.right).toBeLessThanOrEqual(layout!.viewportWidth);
    await page.keyboard.press('Escape');
    await playwrightExpect(page.getByRole('menu')).toHaveCount(0);
    await playwrightExpect(
      page.getByRole('button', { name: new RegExp(`${targetName} 的更多操作`) }),
    ).toBeFocused();
    await page
      .getByRole('button', { name: new RegExp(`${targetName} 的更多操作`) })
      .press('ArrowDown');
    await playwrightExpect(page.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1200, height: 900 });
    await wrapper.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    menu = await openRowMenu(page, targetName);
    const narrowLayout = await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        height: window.innerHeight,
        width: window.innerWidth,
      };
    });
    expect(narrowLayout.top).toBeGreaterThanOrEqual(0);
    expect(narrowLayout.bottom).toBeLessThanOrEqual(narrowLayout.height);
    expect(narrowLayout.left).toBeGreaterThanOrEqual(0);
    expect(narrowLayout.right).toBeLessThanOrEqual(narrowLayout.width);
    await screenshot(page, 'source-menu-1200');
    await page.keyboard.press('Escape');
    await context.close();

    const roleMenus: Partial<Record<Role, string[] | null>> = {};
    for (const role of roles) {
      const cookie = roleCookies[role];
      const app = roleApps[role];
      if (!cookie || !app) continue;
      const roleView = await newPage(cookie, app, 1200);
      await roleView.page.goto(`${app.baseUrl}/dataset/detail?datasetId=${spaceId}`, {
        waitUntil: 'networkidle',
      });
      const more = roleView.page.getByRole('button', { name: /更多操作/ }).first();
      if (!(await more.isVisible().catch(() => false))) {
        roleMenus[role] = null;
      } else {
        await more.click();
        const snapshot = await roleView.page.evaluate(() => {
          const menu = document.querySelector<HTMLElement>('#kb2-product-menu');
          return {
            visible: Boolean(menu),
            labels: Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []).map(
              (item) => item.textContent?.trim() ?? '',
            ),
            html: menu?.outerHTML ?? null,
          };
        });
        if (!snapshot.visible || snapshot.labels.length === 0) {
          throw new Error(`${role} menu snapshot: ${JSON.stringify(snapshot)}`);
        }
        roleMenus[role] = snapshot.labels;
        await roleView.page.screenshot({
          path: join(resultDir, `source-menu-${role}.png`),
        });
      }
      await roleView.context.close();
    }
    expect(roleMenus.read).toBeNull();
    expect(roleMenus.write).toEqual(['移动', '重命名', '标签设置']);
    expect(roleMenus.manage).toEqual(['移动', '重命名', '权限', '标签设置']);
  }, 240_000);
});
