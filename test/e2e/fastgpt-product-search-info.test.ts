import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeConnections } from '../../packages/service/src/shared/runtime/knowledge-connections';
import { apiHeaders, consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_product_search_${suffix}`;
const memberId = `mem_product_search_${suffix}`;
const authToken = `kb-product-search-${suffix}`;
const resultDir = join(root, 'test-results', 'fastgpt-product-module4');

let app: S4AppHarness;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let browser: Browser;
let connections: Awaited<ReturnType<typeof createKnowledgeConnections>>;
let models: ReturnType<typeof registerKnowledgeModels>;
let datasetId = '';
let sourceId = '';
let tagId = '';

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
        idempotencyKey: method === 'GET' ? undefined : `search-${suffix}-${randomUUID()}`,
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
    name: `模块四知识库 ${suffix}`,
    description: '模块四搜索与 Info 验收',
    iconKey: 'book-open',
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
  });
  datasetId = dataset.id;
  const catalog = await api<{
    items: Array<{
      modelId: string;
      displayName: string;
      type: 'llm' | 'embedding' | 'rerank' | 'vlm' | 'stt' | 'tts';
      capabilities: string[];
      authorized: boolean;
    }>;
  }>('/v1/knowledge/models?limit=200', 'GET');
  const selectedModels = catalog.items
    .filter((model) => model.authorized && ['llm', 'embedding', 'rerank'].includes(model.type))
    .filter(
      (model, index, rows) =>
        rows.findIndex((candidate) => candidate.type === model.type) === index,
    );
  const spaceVersion = await api<{ version: number }>(`/v1/knowledge/spaces/${datasetId}`, 'GET');
  await api(`/v1/knowledge/spaces/${datasetId}/model-bindings`, 'PUT', {
    bindings: selectedModels.map((model) => ({
      modelType: model.type,
      modelId: model.modelId,
      displayName: model.displayName,
      requiredCapabilities: model.capabilities,
      status: 'active',
    })),
    version: spaceVersion.version,
  });
  const source = await api<{ id: string }>(`/v1/knowledge/spaces/${datasetId}/sources`, 'POST', {
    kind: 'text',
    directoryId: null,
    name: `模块四搜索源 ${suffix}`,
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
  await api(`/v1/knowledge/sources/${sourceId}/segments`, 'POST', {
    question: '如何联系人工客服？',
    answer: '可以在工作时间内联系人工客服。',
    searchEnabled: true,
    metadata: {},
  });
  const tag = await api<{ id: string }>(`/v1/knowledge/spaces/${datasetId}/tags`, 'POST', {
    key: `search_team_${suffix}`,
    label: '搜索部门',
    tagType: 'array',
    required: false,
    options: ['support'],
  });
  tagId = tag.id;
  await api('/v1/knowledge/sources/tag-assignments', 'POST', {
    items: [{ sourceId, tagId, value: ['support'] }],
  });
}

async function cleanup() {
  if (sourceId) {
    await api(`/v1/knowledge/sources/${sourceId}`, 'DELETE').catch(() => undefined);
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
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_product_search?replicaSet=rs0';
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
    instanceId: `product-search-fixture-${suffix}`,
    mongoUri: process.env.KB_TEST_MONGO_URI,
    redisUrl: process.env.KB_TEST_REDIS_URL,
    pgUrl: process.env.KB_TEST_PG_URL,
    s3: {
      endpoint: process.env.KB_TEST_S3_ENDPOINT,
      region: process.env.KB_TEST_S3_REGION,
      bucket: process.env.KB_TEST_S3_BUCKET,
      accessKeyRef: 'env:KB_PRODUCT_SEARCH_ACCESS',
      secretKeyRef: 'env:KB_PRODUCT_SEARCH_SECRET',
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
        fullTextTokens: '退款 到账 工作日 人工客服 联系',
      },
    },
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

describe('FastGPT product module 4 Search and Info', () => {
  it('runs full-text search, preserves history and keeps the result layout stable', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(`${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=test`, {
      waitUntil: 'networkidle',
    });
    await playwrightExpect(page.getByRole('tab', { name: '搜索测试' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('button', { name: '参数' }).click();
    await page.getByLabel('检索模式').selectOption('fulltext');
    await page.getByRole('button', { name: '完成' }).click();
    await page.getByLabel('测试查询').fill('退款多久到账');
    const searchResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/v1/knowledge/search/full-text'),
    );
    await page.getByRole('button', { name: '开始测试' }).click();
    const searchPayloadResponse = await searchResponse;
    if (searchPayloadResponse.status() !== 200) {
      console.log('search-request', searchPayloadResponse.request().postData());
      console.log('search-failed', await searchPayloadResponse.text());
    }
    expect(searchPayloadResponse.status()).toBe(200);
    await playwrightExpect(page.getByText('测试结果', { exact: false }).first()).toBeVisible();
    await playwrightExpect(page.locator('.kb2-search-result-card').first()).toBeVisible();
    await playwrightExpect(page.getByText('测试历史', { exact: true })).toBeVisible();
    await playwrightExpect(page.getByText('退款多久到账', { exact: false }).first()).toBeVisible();

    await page.reload({ waitUntil: 'networkidle' });
    await playwrightExpect(page.getByText('退款多久到账', { exact: false }).first()).toBeVisible();
    await page.getByRole('button', { name: '退款多久到账' }).click();
    await playwrightExpect(page.locator('.kb2-search-result-card').first()).toBeVisible();

    await page.getByLabel('测试查询').fill('不存在的查询');
    const emptyResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/v1/knowledge/search/full-text'),
    );
    await page.getByRole('button', { name: '开始测试' }).click();
    expect((await emptyResponse).status()).toBe(200);
    await playwrightExpect(page.getByText('搜索结果为空').last()).toBeVisible();
    await playwrightExpect(page.locator('.kb2-search-result-card').first()).toBeVisible();

    for (const width of [1440, 1200, 900]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${width}px search overflow`).toBeLessThanOrEqual(1);
    }
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: join(resultDir, 'search-1440.png'), fullPage: true });

    await page
      .locator('input[type="file"]')
      .setInputFiles(join(root, 'test/fixtures/s11/generated/s11-image-1x1.png'));
    await playwrightExpect(page.getByText(/uploading|completing|completed/).first()).toBeVisible();
    await page.getByLabel('测试查询').fill('退款流程图片');
    const imageResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/v1/knowledge/search/image'),
    );
    await page.getByRole('button', { name: '开始测试' }).click();
    expect((await imageResponse).url()).toContain('/search/image');
    await context.close();
  });

  it('updates model bindings and collaborators from the Info rail', async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=collectionCard`,
      { waitUntil: 'networkidle' },
    );
    await playwrightExpect(
      page.getByRole('heading', { level: 1, name: new RegExp(`模块四知识库 ${suffix}`) }),
    ).toBeVisible();
    await page.getByRole('button', { name: '编辑模型配置' }).click();
    const modelModal = page.locator('.kb2-modal');
    await playwrightExpect(modelModal.getByText('模型配置', { exact: true })).toBeVisible();
    const llmSelect = modelModal.getByLabel('文本理解模型');
    if ((await llmSelect.locator('option').count()) > 1) {
      await llmSelect.selectOption({ index: 1 });
      const saveResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          response.url().endsWith(`/spaces/${datasetId}/model-bindings`),
      );
      await modelModal.getByRole('button', { name: '保存' }).click();
      expect((await saveResponse).status()).toBe(200);
    } else {
      await modelModal.getByRole('button', { name: '取消' }).click();
    }

    await page.getByRole('button', { name: '管理知识库权限' }).click();
    const permissionModal = page.locator('.kb2-modal');
    await permissionModal.getByLabel('成员 ID').fill(`mem_search_collaborator_${suffix}`);
    await permissionModal.getByLabel('角色').selectOption('read');
    const collaboratorResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/spaces/${datasetId}/collaborators`),
    );
    await permissionModal.getByRole('button', { name: '添加', exact: true }).click();
    expect((await collaboratorResponse).status()).toBe(201);
    await playwrightExpect(
      permissionModal
        .locator('.kb2-tag-manager-row')
        .first()
        .getByText(`mem_search_collaborator_${suffix}`),
    ).toBeVisible();
    await permissionModal.getByRole('button', { name: '关闭弹窗' }).click();
    await playwrightExpect(page.locator('.kb2-modal')).toHaveCount(0);

    await context.close();
  });
});
