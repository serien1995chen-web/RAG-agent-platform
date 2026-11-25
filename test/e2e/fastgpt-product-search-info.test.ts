import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeConnections } from '../../packages/service/src/shared/runtime/knowledge-connections';
import { apiHeaders, consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';
import { chooseDifferentModel } from './model-select-helpers';

const root = resolve(import.meta.dirname, '../..');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_product_search_${suffix}`;
const memberId = `mem_product_search_${suffix}`;
const collaboratorId = `mem_search_collaborator_${suffix}`;
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
  const taggedSource = await api<{ version: number }>(`/v1/knowledge/sources/${sourceId}`, 'GET');
  await api('/v1/knowledge/sources/tag-assignments', 'POST', {
    items: [{ sourceId, tagId, value: ['support'] }],
    sourceVersions: { [sourceId]: taggedSource.version },
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

  app = await startS4App({
    suffix,
    workspaceId,
    memberId,
    authToken,
    workspaceMemberIds: [collaboratorId],
  });
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
    await page.getByRole('button', { name: '搜索配置' }).click();
    await page.getByRole('radio', { name: '全文检索' }).check();
    await page.getByRole('button', { name: '完成' }).click();
    await page.getByLabel('测试查询').fill('退款多久到账');
    const searchResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/v1/knowledge/search/full-text'),
    );
    await page.getByRole('button', { name: '测试', exact: true }).click();
    const searchPayloadResponse = await searchResponse;
    if (searchPayloadResponse.status() !== 200) {
      console.log('search-request', searchPayloadResponse.request().postData());
      console.log('search-failed', await searchPayloadResponse.text());
    }
    expect(searchPayloadResponse.status()).toBe(200);
    await playwrightExpect(page.getByText('测试结果', { exact: false }).first()).toBeVisible();
    const resultCard = page.locator('.kb2-search-result-card').first();
    await playwrightExpect(resultCard).toBeVisible();
    await playwrightExpect(resultCard.getByText(`知识库 ${datasetId}`)).toBeVisible();
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
    await page.getByRole('button', { name: '测试', exact: true }).click();
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

    const imageUpload = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/v1/knowledge/uploads',
    );
    await page
      .locator('input[type="file"]')
      .setInputFiles(join(root, 'test/fixtures/s11/generated/s11-image-1x1.png'));
    expect((await imageUpload).status()).toBe(201);
    await page.getByLabel('测试查询').fill('退款流程图片');
    const imageResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/v1/knowledge/search/image'),
    );
    await page.getByRole('button', { name: '测试', exact: true }).click();
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
    const llmSelect = page.locator('button:visible[aria-label^="文本理解模型"]').last();
    const selectedLlm = await llmSelect.getAttribute('aria-label');
    expect(selectedLlm).toBeTruthy();
    {
      const saveResponse = page
        .waitForResponse(
          (response) =>
            response.request().method() === 'PUT' &&
            response.url().endsWith(`/spaces/${datasetId}/model-bindings`),
        )
        .catch(() => null);
      const alternateLlm = await chooseDifferentModel(page, '文本理解模型');
      if (alternateLlm) expect((await saveResponse)?.status()).toBe(200);
    }

    await page.getByRole('button', { name: '管理协作者' }).click();
    const permissionModal = page.locator('.kb2-modal');
    await permissionModal.getByRole('button', { name: '成员' }).click();
    await permissionModal.getByRole('button', { name: collaboratorId }).click();
    await permissionModal.getByLabel(`${collaboratorId} 的角色`).selectOption('read');
    const collaboratorResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/spaces/${datasetId}/collaborators`),
    );
    await permissionModal.getByRole('button', { name: '确认', exact: true }).click();
    expect((await collaboratorResponse).status()).toBe(201);
    await playwrightExpect(permissionModal).toHaveCount(0);
    await playwrightExpect(page.locator('.kb2-modal')).toHaveCount(0);

    await context.close();
  });

  it('L1-B15-A-MODEL-001-UI01 preserves all model roles and starts rebuild after index model change', async () => {
    const catalog = await api<{
      items: Array<{
        modelId: string;
        displayName: string;
        type: 'llm' | 'embedding' | 'rerank' | 'vlm' | 'stt' | 'tts';
        capabilities: string[];
        authorized: boolean;
      }>;
    }>('/v1/knowledge/models?limit=200', 'GET');
    const selectedModels = (['llm', 'embedding', 'rerank', 'vlm', 'stt', 'tts'] as const).flatMap(
      (type) => {
        const model = catalog.items.find(
          (candidate) => candidate.authorized && candidate.type === type,
        );
        return model
          ? [
              {
                modelType: type,
                modelId: model.modelId,
                displayName: model.displayName,
                requiredCapabilities: model.capabilities,
                status: 'active' as const,
              },
            ]
          : [];
      },
    );
    expect(selectedModels).toHaveLength(6);
    const space = await api<{ version: number }>(`/v1/knowledge/spaces/${datasetId}`, 'GET');
    await api(`/v1/knowledge/spaces/${datasetId}/model-bindings`, 'PUT', {
      bindings: selectedModels,
      version: space.version,
    });

    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=collectionCard`,
      { waitUntil: 'networkidle' },
    );
    const jobsBefore = await models.KnowledgeJob.find({
      workspaceId,
      knowledgeSpaceId: datasetId,
      deletedAt: null,
    })
      .select({ _id: 1, kind: 1, status: 1, inputSnapshot: 1 })
      .lean<
        Array<{
          _id: unknown;
          kind: string;
          status: string;
          inputSnapshot: Record<string, unknown>;
        }>
      >();
    const jobIdsBefore = new Set(jobsBefore.map((job) => String(job._id)));
    const bindingsBefore = await api<{
      items: Array<{ modelType: string; modelId: string }>;
    }>(`/v1/knowledge/spaces/${datasetId}/model-bindings`, 'GET');
    const currentEmbeddingModel =
      bindingsBefore.items.find((item) => item.modelType === 'embedding')?.modelId ?? '';
    expect(currentEmbeddingModel).toBeTruthy();
    const confirmModal = page.locator('.kb2-modal');
    expect(await chooseDifferentModel(page, '索引模型')).toBeTruthy();
    await playwrightExpect(confirmModal.getByText('确认重建索引')).toBeVisible();
    const confirmRebuild = confirmModal.getByRole('button', { name: /确认重建/ });
    await playwrightExpect(confirmRebuild).toBeDisabled();
    await playwrightExpect(confirmRebuild).toBeEnabled({ timeout: 5_000 });
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith(`/spaces/${datasetId}/model-bindings`),
    );
    await confirmRebuild.click();
    expect((await saved).status()).toBe(200);

    const after = await api<{
      items: Array<{ modelType: string; modelId: string }>;
    }>(`/v1/knowledge/spaces/${datasetId}/model-bindings`, 'GET');
    const jobsAfter = await models.KnowledgeJob.find({
      workspaceId,
      knowledgeSpaceId: datasetId,
      deletedAt: null,
    })
      .select({ _id: 1, kind: 1, status: 1, inputSnapshot: 1 })
      .lean<
        Array<{
          _id: unknown;
          kind: string;
          status: string;
          inputSnapshot: Record<string, unknown>;
        }>
      >();
    const newJobs = jobsAfter.filter((job) => !jobIdsBefore.has(String(job._id)));
    const activeEmbeddingBinding = await models.KnowledgeModelBinding.findOne({
      workspaceId,
      knowledgeSpaceId: datasetId,
      modelType: 'embedding',
      deletedAt: null,
    })
      .select({ activeQueryModelId: 1, activeQueryDimension: 1 })
      .lean<{ activeQueryModelId: string | null; activeQueryDimension: number | null }>();
    await writeFile(
      join(resultDir, 'b15-model-binding-result.json'),
      `${JSON.stringify(
        {
          testId: 'L1-B15-A-MODEL-001-UI01',
          expectedModelTypes: selectedModels.map((item) => item.modelType).sort(),
          actualModelTypes: after.items.map((item) => item.modelType).sort(),
          activeQueryModelId: activeEmbeddingBinding?.activeQueryModelId ?? null,
          activeQueryDimension: activeEmbeddingBinding?.activeQueryDimension ?? null,
          newJobs: newJobs.map((job) => ({
            kind: job.kind,
            status: job.status,
            inputSnapshot: job.inputSnapshot,
          })),
        },
        null,
        2,
      )}\n`,
    );
    await page.screenshot({
      path: join(resultDir, 'b15-model-binding-after-save.png'),
      fullPage: true,
    });
    expect
      .soft(after.items.map((item) => item.modelType).sort())
      .toEqual(selectedModels.map((item) => item.modelType).sort());
    const rebuildJob = newJobs.find(
      (job) => job.kind === 'rebuild' || job.kind === 'synonym_rebuild',
    );
    expect.soft(rebuildJob).toBeDefined();
    expect
      .soft(rebuildJob?.inputSnapshot?.targetModelId)
      .toBe(after.items.find((item) => item.modelType === 'embedding')?.modelId);
    expect.soft(activeEmbeddingBinding?.activeQueryModelId).toBe(currentEmbeddingModel);
    await context.close();
  });

  it('L1-B14-TRAIN-006-UI01 requires an explicit rebuild confirmation before changing the index model', async () => {
    const confirmationSpace = await api<{ id: string }>('/v1/knowledge/spaces', 'POST', {
      kind: 'space',
      parentSpaceId: null,
      name: `B14 模型切换确认 ${suffix}`,
      description: '',
      iconKey: 'book-open',
      accessMode: 'workspace',
      sourceAclMode: 'inherited',
      sourcePermissionEnabled: true,
    });
    const catalog = await api<{
      items: Array<{
        modelId: string;
        displayName: string;
        type: string;
        capabilities: string[];
        authorized: boolean;
      }>;
    }>('/v1/knowledge/models?limit=200', 'GET');
    const embeddingModels = catalog.items.filter(
      (model) => model.type === 'embedding' && model.authorized,
    );
    expect(embeddingModels.length).toBeGreaterThanOrEqual(2);
    const initialModel = embeddingModels[0]!;
    const initialSpace = await api<{ version: number }>(
      `/v1/knowledge/spaces/${confirmationSpace.id}`,
      'GET',
    );
    await api(`/v1/knowledge/spaces/${confirmationSpace.id}/model-bindings`, 'PUT', {
      bindings: [
        {
          modelType: 'embedding',
          modelId: initialModel.modelId,
          displayName: initialModel.displayName,
          requiredCapabilities: initialModel.capabilities,
          status: 'active',
        },
      ],
      version: initialSpace.version,
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    let immediateBindingUpdate = false;
    page.on('request', (request) => {
      if (
        request.method() === 'PUT' &&
        request.url().endsWith(`/spaces/${confirmationSpace.id}/model-bindings`)
      ) {
        immediateBindingUpdate = true;
      }
    });
    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${confirmationSpace.id}&currentTab=collectionCard`,
      { waitUntil: 'networkidle' },
    );
    expect(await chooseDifferentModel(page, '索引模型')).toBeTruthy();
    await page.waitForTimeout(500);

    expect(immediateBindingUpdate).toBe(false);
    await playwrightExpect(page.locator('.kb2-modal')).toHaveCount(1);
    await playwrightExpect(page.getByText(/重建索引/)).toBeVisible();
    const confirmButton = page.getByRole('button', { name: /确认重建/ });
    await playwrightExpect(confirmButton).toBeVisible();
    await playwrightExpect(confirmButton).toBeDisabled();

    await page.getByRole('button', { name: '取消' }).click();
    await playwrightExpect(page.locator('.kb2-modal')).toHaveCount(0);
    expect(immediateBindingUpdate).toBe(false);

    expect(await chooseDifferentModel(page, '索引模型')).toBeTruthy();
    const rebuilt = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith(`/spaces/${confirmationSpace.id}/model-bindings`),
    );
    const enabledConfirm = page.getByRole('button', { name: /确认重建/ });
    await playwrightExpect(enabledConfirm).toBeEnabled({ timeout: 5_000 });
    await enabledConfirm.click();
    expect((await rebuilt).status()).toBe(200);
    expect(immediateBindingUpdate).toBe(true);
    await context.close();
  });
});
