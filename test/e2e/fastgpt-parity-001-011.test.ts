import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeConnections } from '../../packages/service/src/shared/runtime/knowledge-connections';
import { apiHeaders, consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_parity_001_011_${suffix}`;
const memberId = `mem_parity_owner_${suffix}`;
const collaboratorId = `mem_parity_collaborator_${suffix}`;
const authToken = `kb-parity-001-011-${suffix}`;
const resultDir = join(root, 'test-results', 'fastgpt-parity-001-011');
const directoryFile = join(resultDir, 'console-directory.json');

let app: S4AppHarness;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let browser: Browser;
let connections: Awaited<ReturnType<typeof createKnowledgeConnections>>;
let models: ReturnType<typeof registerKnowledgeModels>;
let datasetId = '';
let sourceId = '';

async function api<T = Record<string, unknown>>(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...apiHeaders({
        authToken,
        workspaceId,
        idempotencyKey: method === 'GET' ? undefined : `parity-${suffix}-${randomUUID()}`,
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
  const space = await api<{ id: string }>('/v1/knowledge/spaces', 'POST', {
    kind: 'space',
    parentSpaceId: null,
    name: `Parity 001-011 ${suffix}`,
    description: 'FastGPT 知识库交互对齐验收',
    iconKey: 'book-open',
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: false,
  });
  datasetId = space.id;
  const source = await api<{ id: string }>(`/v1/knowledge/spaces/${datasetId}/sources`, 'POST', {
    kind: 'text',
    directoryId: null,
    name: `退款说明 ${suffix}`,
    searchEnabled: true,
    metadata: {},
  });
  sourceId = source.id;
  await api(`/v1/knowledge/sources/${sourceId}/segments`, 'POST', {
    question: '退款多久到账？',
    answer: '退款通常会在五个工作日内到账。',
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
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_fastgpt_parity?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-local';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';
  await mkdir(resultDir, { recursive: true });
  await writeFile(
    directoryFile,
    `${JSON.stringify(
      {
        members: [
          { memberId, name: '林知远', departmentIds: ['engineering'], groupIds: ['owners'] },
          {
            memberId: collaboratorId,
            name: '陈协作',
            departmentIds: ['engineering'],
            groupIds: ['support'],
          },
        ],
        departments: [{ id: 'engineering', name: '研发部', parentId: null }],
        groups: [{ id: 'support', name: '客服群组', parentId: null }],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  app = await startS4App({
    suffix,
    workspaceId,
    memberId,
    authToken,
    workspaceMemberIds: [collaboratorId],
    consoleDirectoryFile: directoryFile,
  });
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
  await seed();
  connections = await createKnowledgeConnections({
    environment: 'test',
    workerMode: 'http',
    port: 3010,
    instanceId: `parity-001-011-${suffix}`,
    mongoUri: process.env.KB_TEST_MONGO_URI,
    redisUrl: process.env.KB_TEST_REDIS_URL,
    pgUrl: process.env.KB_TEST_PG_URL,
    s3: {
      endpoint: process.env.KB_TEST_S3_ENDPOINT,
      region: process.env.KB_TEST_S3_REGION,
      bucket: process.env.KB_TEST_S3_BUCKET,
      accessKeyRef: 'env:KB_PARITY_ACCESS',
      secretKeyRef: 'env:KB_PARITY_SECRET',
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
  await models.KnowledgeSource.updateOne(
    { workspaceId, _id: sourceId },
    { $set: { processingStatus: 'ready' } },
  );
  await models.KnowledgeSegment.updateMany(
    { workspaceId, sourceId },
    {
      $set: {
        indexStatus: 'indexed',
        fullTextTokens: '退款 到账 工作日',
      },
    },
  );
  browser = await chromium.launch({ headless: true });
}, 240_000);

afterAll(async () => {
  await cleanup();
  await connections?.close();
  await browser?.close();
  await app?.close();
}, 60_000);

describe('FastGPT knowledge parity KB-PARITY-001 through 011', () => {
  it('locks three create/detail models and removes task/operations product entries', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    await page.goto(`${app.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '新建' }).click();
    await page.getByRole('menuitem', { name: /通用知识库/ }).click();
    const createDialog = page.getByRole('dialog');
    for (const label of ['索引模型', '文本理解模型', '图片理解模型']) {
      await playwrightExpect(createDialog.getByText(label, { exact: true })).toBeVisible();
    }
    for (const label of ['重排模型', '语音识别模型', '语音合成模型']) {
      await playwrightExpect(createDialog.getByText(label, { exact: true })).toHaveCount(0);
    }
    await createDialog.getByRole('button', { name: '关闭', exact: true }).click();

    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=collectionCard`,
      {
        waitUntil: 'networkidle',
      },
    );
    const info = page.getByRole('complementary', { name: '知识库信息' });
    await playwrightExpect(info).toBeVisible();
    for (const label of ['索引模型', '文本理解模型', '图片理解模型']) {
      await playwrightExpect(info.getByText(label, { exact: true })).toBeVisible();
    }
    for (const label of ['重排模型', '语音识别模型', '语音合成模型']) {
      await playwrightExpect(info.getByText(label, { exact: true })).toHaveCount(0);
    }
    await playwrightExpect(page.getByText('任务中心')).toHaveCount(0);
    await playwrightExpect(page.getByRole('link', { name: '运营' })).toHaveCount(0);

    await page.goto(`${app.baseUrl}/spaces/${datasetId}/jobs`, { waitUntil: 'networkidle' });
    await page.waitForURL(/\/dataset\/detail/);
    await page.goto(`${app.baseUrl}/settings/operations`, { waitUntil: 'networkidle' });
    await page.waitForURL(/\/dataset\/list/);
    await context.close();
  }, 180_000);

  it('uses the two-column collaborator flow, supports cancel without writes and batch confirmation', async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=collectionCard`,
      {
        waitUntil: 'networkidle',
      },
    );
    await page.getByRole('button', { name: '管理协作者' }).click();
    let dialog = page.getByRole('dialog', { name: '管理协作者' });
    await playwrightExpect(dialog).toBeVisible();
    await playwrightExpect(dialog.getByText(/ACL|权限版本|主体 ID/)).toHaveCount(0);
    await dialog.getByRole('button', { name: '成员' }).click();
    await dialog.getByRole('button', { name: '陈协作' }).click();
    await dialog.getByLabel('陈协作 的角色').selectOption('manage');
    let writes = 0;
    const countWrites = (request: { method(): string; url(): string }) => {
      if (
        request.method() !== 'GET' &&
        new URL(request.url()).pathname.startsWith('/v1/knowledge/')
      ) {
        writes += 1;
      }
    };
    page.on('request', countWrites);
    await dialog.getByRole('button', { name: '取消' }).click();
    expect(writes).toBe(0);
    page.off('request', countWrites);

    await page.getByRole('button', { name: '管理协作者' }).click();
    dialog = page.getByRole('dialog', { name: '管理协作者' });
    await dialog.getByRole('button', { name: '成员' }).click();
    await dialog.getByRole('button', { name: '陈协作' }).click();
    await dialog.getByLabel('陈协作 的角色').selectOption('manage');
    await dialog.getByRole('button', { name: /团队/ }).click();
    await dialog.getByRole('button', { name: '部门' }).click();
    await dialog.getByRole('button', { name: '研发部' }).click();
    await dialog.getByRole('button', { name: /团队/ }).click();
    await dialog.getByRole('button', { name: '群组' }).click();
    await dialog.getByRole('button', { name: '客服群组' }).click();
    const collaboratorSaved = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/spaces/${datasetId}/collaborators`),
    );
    const aclSaved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith(`/resources/space/${datasetId}/acl`),
    );
    await dialog.getByRole('button', { name: '确认', exact: true }).click();
    expect((await collaboratorSaved).status()).toBe(201);
    expect((await aclSaved).status()).toBe(200);
    await playwrightExpect(dialog).toHaveCount(0);

    await page.getByRole('button', { name: '管理协作者' }).click();
    dialog = page.getByRole('dialog', { name: '管理协作者' });
    await playwrightExpect(dialog.getByText('陈协作', { exact: true })).toBeVisible();
    await playwrightExpect(dialog.getByText('研发部', { exact: true })).toBeVisible();
    await playwrightExpect(dialog.getByText('客服群组', { exact: true })).toBeVisible();
    await playwrightExpect(
      dialog.getByRole('button', { name: /移除 (林知远|知识库创建者)/ }),
    ).toBeDisabled();
    await page.waitForTimeout(300);
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
    await page.screenshot({
      path: join(resultDir, 'collaborators-1200.png'),
      fullPage: true,
    });
    await context.close();
  }, 180_000);

  it('aligns the Search Test layout, three tabs, defaults, candidate count and history parameters', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    await page.goto(`${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=test`, {
      waitUntil: 'networkidle',
    });
    await playwrightExpect(page.getByRole('heading', { name: '输入测试内容' })).toBeVisible();
    await playwrightExpect(
      page.getByRole('radio', { name: /Deep RAG|深度检索|深度搜索/ }),
    ).toHaveCount(0);
    await playwrightExpect(page.getByText(/Deep RAG/)).toHaveCount(0);
    await page.getByRole('button', { name: '搜索配置' }).click();
    let dialog = page.getByRole('dialog', { name: '知识库搜索配置' });
    await playwrightExpect(dialog.getByRole('tab')).toHaveCount(3);
    await playwrightExpect(dialog.getByRole('radio', { name: '语义检索' })).toBeChecked();
    await dialog.getByRole('tab', { name: '搜索过滤' }).click();
    await playwrightExpect(dialog.getByLabel('引用上限')).toHaveValue('5000');
    await playwrightExpect(dialog.getByLabel('最低相关度')).toHaveValue('0');
    await dialog.getByRole('tab', { name: '搜索方式' }).click();
    await dialog.getByRole('radio', { name: '全文检索' }).check();
    await dialog.getByRole('checkbox', { name: '结果重排' }).check();
    await playwrightExpect(dialog.getByLabel('重排候选数')).toHaveValue('100');
    await dialog.getByLabel('重排候选数').fill('30');
    await dialog.getByRole('button', { name: '完成' }).click();

    await page.getByLabel('测试查询').fill('退款多久到账');
    const searchResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/v1/knowledge/search/full-text'),
    );
    await page.getByRole('button', { name: '测试', exact: true }).click();
    const response = await searchResponse;
    expect(response.status()).toBe(200);
    const payload = JSON.parse(response.request().postData() ?? '{}') as {
      usingRerank?: boolean;
      rerankCandidateNum?: number;
      rerankModelId?: string;
    };
    await response.json();
    expect(payload.usingRerank).toBe(true);
    expect(payload.rerankCandidateNum).toBe(30);
    expect(payload.rerankModelId).toBeUndefined();
    await playwrightExpect(page.getByText('重排候选 30', { exact: false })).toBeVisible();

    await page.getByRole('button', { name: '搜索配置' }).click();
    dialog = page.getByRole('dialog', { name: '知识库搜索配置' });
    await dialog.getByRole('tab', { name: '搜索过滤' }).click();
    await dialog.getByLabel('最低相关度').fill('0.8');
    await dialog.getByRole('button', { name: '完成' }).click();
    await page.locator('.kb2-search-history button').first().click();
    await playwrightExpect(page.getByText('最低相关度 0', { exact: false }).first()).toBeVisible();
    await playwrightExpect(page.getByText('最低相关度 0.8', { exact: false })).toHaveCount(0);

    for (const width of [1440, 1200]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${width}px horizontal overflow`).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: join(resultDir, `search-${width}.png`),
        fullPage: true,
      });
    }
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
    await context.close();
  }, 180_000);
});
