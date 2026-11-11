import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import {
  chromium,
  expect as playwrightExpect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import { apiHeaders, consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_b04_e2e_${suffix}`;
const memberId = `mem_b04_e2e_${suffix}`;
const authToken = `kb-b04-e2e-${suffix}`;
const resultDir = join(root, 'test-results', 'b04', '20261112-b04-phase-a', 'ui');

let app: S4AppHarness;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let browser: Browser;
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let spaceId = '';
let sourceId = '';
let indexedSegmentId = '';
let indexingSegmentId = '';
let failedSegmentId = '';
let deleteSegmentId = '';

async function api<T = Record<string, unknown>>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<{ status: number; data: T; payload: Record<string, unknown> }> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...apiHeaders({
        authToken,
        workspaceId,
        idempotencyKey: method === 'GET' ? undefined : `b04-${suffix}-${randomUUID()}`,
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
    throw new Error(
      `${method} ${path} failed: ${response.status} ${payload.error?.code ?? JSON.stringify(payload)}`,
    );
  }
  return { status: response.status, data: payload.data as T, payload };
}

function segmentIndex(input: { indexId: string; type: 'default' | 'custom'; text: string }) {
  return {
    indexId: input.indexId,
    type: input.type,
    modelId: 'mock-embedding-1024',
    dimension: 1024,
    storageType: 'vector',
    vectorProfile: 'knowledge_segment_vectors_1024',
    vectorId: randomUUID(),
    text: input.text,
    version: 2,
  };
}

async function seed() {
  const space = await api<{ id: string }>('/v1/knowledge/spaces', 'POST', {
    kind: 'space',
    parentSpaceId: null,
    name: `B04 验收空间 ${suffix}`,
    description: 'B04 Segment CRUD、索引与状态',
    iconKey: 'book-open',
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
  });
  spaceId = space.data.id;
  const source = await api<{ id: string }>(`/v1/knowledge/spaces/${spaceId}/sources`, 'POST', {
    kind: 'text',
    directoryId: null,
    name: `B04 数据源 ${suffix}`,
    searchEnabled: true,
    metadata: {},
  });
  sourceId = source.data.id;

  const create = async (question: string, answer: string) =>
    (
      await api<{ id: string }>(`/v1/knowledge/sources/${sourceId}/segments`, 'POST', {
        question,
        answer,
        searchEnabled: true,
        metadata: { suite: 'b04', suffix },
      })
    ).data.id;

  indexedSegmentId = await create('退款多久到账？', '退款通常会在五个工作日内到账。');
  indexingSegmentId = await create('索引中的问题', '索引中的答案');
  failedSegmentId = await create('重建失败的问题', '重建失败的答案');
  deleteSegmentId = await create('待删除的数据块', '删除目标答案');

  const models = registerKnowledgeModels(connection);
  await models.KnowledgeSegment.updateOne(
    { _id: indexedSegmentId, workspaceId },
    {
      $set: {
        version: 2,
        indexStatus: 'indexed',
        indexErrorCode: null,
        indexes: [
          segmentIndex({
            indexId: 'default',
            type: 'default',
            text: '退款通常会在五个工作日内到账。',
          }),
          segmentIndex({
            indexId: 'custom_refund',
            type: 'custom',
            text: '退款自定义索引初始值',
          }),
        ],
      },
    },
  );
  await models.KnowledgeSegment.updateOne(
    { _id: indexingSegmentId, workspaceId },
    { $set: { indexStatus: 'indexing', indexErrorCode: null } },
  );
  await models.KnowledgeSegment.updateOne(
    { _id: failedSegmentId, workspaceId },
    {
      $set: {
        indexStatus: 'rebuild_failed',
        indexErrorCode: 'KNOWLEDGE_MODEL_FAILED',
        indexes: [
          segmentIndex({
            indexId: 'default',
            type: 'default',
            text: '重建失败的答案',
          }),
          segmentIndex({
            indexId: 'custom_failed',
            type: 'custom',
            text: '失败索引的可恢复内容',
          }),
        ],
      },
    },
  );
  await models.KnowledgeSegment.updateOne(
    { _id: deleteSegmentId, workspaceId },
    { $set: { indexStatus: 'indexed', indexErrorCode: null } },
  );
}

async function newContext(input: { hidden?: boolean } = {}): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  });
  await context.addCookies([cookie]);
  if (input.hidden) {
    await context.addInitScript(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => true,
      });
    });
  }
  return context;
}

async function gotoData(page: Page) {
  await page.goto(
    `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=dataCard&collectionId=${sourceId}`,
    { waitUntil: 'networkidle' },
  );
  await playwrightExpect(
    page.getByRole('heading', { level: 1, name: new RegExp(`B04 数据源 ${suffix}`) }),
  ).toBeVisible();
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_test?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-test';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
  connection = await createKnowledgeMongoConnection(process.env.KB_TEST_MONGO_URI);
  await seed();
  await mkdir(resultDir, { recursive: true });
  browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
  if (connection) {
    for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
      await connection.models[entry.modelName]?.deleteMany({ workspaceId });
    }
    await connection.close();
  }
  await browser?.close();
  await app?.close();
}, 60_000);

describe.sequential('B04 product Data UI', () => {
  it('L1-B04-DATA-001-UI01 current product Data route supports search edit refresh delete and processing protection', async () => {
    const context = await newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await gotoData(page);
    await playwrightExpect(page.locator('.kb2-data-card')).toHaveCount(4);
    await playwrightExpect(page.getByText(indexedSegmentId, { exact: true }).first()).toBeVisible();
    await playwrightExpect(page.getByText('已索引').first()).toBeVisible();
    await playwrightExpect(page.getByText('索引中').first()).toBeVisible();
    await playwrightExpect(page.getByText('索引异常').first()).toBeVisible();

    await page.getByLabel('搜索数据块').fill('待删除');
    await playwrightExpect(page.locator('.kb2-data-card')).toHaveCount(1);
    await page.getByLabel('搜索数据块').fill('没有这个数据');
    await playwrightExpect(page.getByText('没有匹配的数据块', { exact: true })).toBeVisible();
    await page.getByLabel('搜索数据块').fill('');
    await playwrightExpect(page.locator('.kb2-data-card')).toHaveCount(4);

    await page.getByRole('button', { name: '编辑数据块 1' }).click();
    const editor = page.locator('.kb2-modal').filter({ hasText: '编辑数据 #1' });
    await editor.locator('textarea').first().fill('退款多久到账？已更新');
    await editor.locator('textarea').nth(1).fill('退款通常会在三个工作日内到账。');
    await editor.getByRole('checkbox', { name: '参与检索' }).uncheck();
    const updateResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().endsWith(`/segments/${indexedSegmentId}`),
    );
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    expect((await updateResponse).status()).toBe(200);
    await playwrightExpect(page.getByText('退款多久到账？已更新').first()).toBeVisible();

    await page.reload({ waitUntil: 'networkidle' });
    await playwrightExpect(page.getByText('退款多久到账？已更新').first()).toBeVisible();
    await playwrightExpect(page.getByText('退款通常会在三个工作日内到账。').first()).toBeVisible();

    await page.getByRole('button', { name: '删除数据块 4' }).click();
    const deleteDialog = page.locator('.kb2-modal').filter({ hasText: '删除数据' });
    await deleteDialog.getByRole('button', { name: '取消', exact: true }).click();
    await playwrightExpect(page.locator('.kb2-data-card')).toHaveCount(4);
    await page.getByRole('button', { name: '删除数据块 4' }).click();
    const deleteResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url().endsWith(`/segments/${deleteSegmentId}`),
    );
    await deleteDialog.getByRole('button', { name: '确认删除', exact: true }).click();
    expect([200, 202, 204]).toContain((await deleteResponse).status());
    await playwrightExpect(page.locator('.kb2-data-card')).toHaveCount(3);

    await page.getByRole('button', { name: '编辑数据块 2' }).click();
    await playwrightExpect(page.getByText('数据索引中，暂不可更改')).toBeVisible();
    await playwrightExpect(page.locator('#kb2-segment-form')).toHaveCount(0);

    await page.screenshot({ path: join(resultDir, 'b04-data-crud.png'), fullPage: true });
    expect(consoleErrors).toEqual([]);
    await context.close();
  });

  it('L1-B04-DATA-002-UI01 system index is read-only and custom index final value can be saved', async () => {
    const context = await newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await gotoData(page);
    await page.getByRole('button', { name: '编辑数据块 1' }).click();
    const editor = page.locator('.kb2-modal').filter({ hasText: '编辑数据 #1' });
    await playwrightExpect(editor.getByText('索引 2', { exact: true })).toBeVisible();
    await playwrightExpect(editor.getByText('系统索引只读', { exact: true })).toBeVisible();
    const defaultRow = editor.locator('.kb2-index-row').filter({ hasText: 'default' });
    await playwrightExpect(defaultRow.getByRole('button')).toHaveCount(0);
    const customRow = editor.locator('.kb2-index-row').filter({ has: page.locator('textarea') });
    await customRow.locator('textarea').fill('退款自定义索引最终值');
    const updateResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().endsWith(`/segments/${indexedSegmentId}/indexes/custom_refund`),
    );
    await customRow.getByRole('button', { name: '重新保存', exact: true }).click();
    expect((await updateResponse).status()).toBe(200);
    await playwrightExpect(customRow.locator('textarea')).toHaveValue('退款自定义索引最终值');
    await page.screenshot({ path: join(resultDir, 'b04-custom-index.png'), fullPage: true });
    await context.close();
  });

  it('L1-B04-DATA-001-UI03 Data editor and status surfaces have no serious axe violations', async () => {
    const context = await newContext();
    const page = await context.newPage();
    await gotoData(page);
    await page.screenshot({ path: join(resultDir, 'b04-a11y-status.png'), fullPage: true });
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
    await context.close();
  });

  it('L1-B04-DATA-002-UI02 persisted Segment and index history is discoverable from the Data editor', async () => {
    await registerKnowledgeModels(connection).KnowledgeSegment.updateOne(
      { _id: indexedSegmentId, workspaceId },
      { $set: { indexStatus: 'indexed', indexErrorCode: null } },
    );
    const context = await newContext();
    const page = await context.newPage();
    await gotoData(page);
    await page.getByRole('button', { name: '编辑数据块 1' }).click();
    const editor = page.locator('.kb2-modal').filter({ hasText: '编辑数据 #1' });
    await page.screenshot({ path: join(resultDir, 'b04-history.png'), fullPage: true });
    await playwrightExpect(
      editor.getByRole('heading', { name: /编辑历史|历史版本/ }),
    ).toBeVisible();
    await context.close();
  });

  it('L1-B04-DATA-002-N02 direct API cannot update or delete a generated system index', async () => {
    const failedSegment = await api<{ version: number }>(
      `/v1/knowledge/segments/${failedSegmentId}`,
      'GET',
    );
    const updateResponse = await fetch(
      `${app.baseUrl}/v1/knowledge/segments/${failedSegmentId}/indexes/default`,
      {
        method: 'PATCH',
        headers: {
          ...apiHeaders({
            authToken,
            workspaceId,
            idempotencyKey: `b04-system-index-${suffix}`,
          }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          indexId: 'default',
          type: 'custom',
          text: 'attempt to modify generated system index',
          modelId: 'mock-embedding-1024',
          version: failedSegment.data.version,
        }),
      },
    );
    expect([400, 403, 409]).toContain(updateResponse.status);
    const deleteResponse = await fetch(
      `${app.baseUrl}/v1/knowledge/segments/${failedSegmentId}/indexes/default`,
      {
        method: 'DELETE',
        headers: {
          ...apiHeaders({
            authToken,
            workspaceId,
            idempotencyKey: `b04-system-index-delete-${suffix}`,
          }),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ version: failedSegment.data.version }),
      },
    );
    expect([400, 403, 409]).toContain(deleteResponse.status);
  });

  it('L1-B04-DATA-003-UI01 failure reason and Job status detail are discoverable after reopening a failed Segment', async () => {
    await registerKnowledgeModels(connection).KnowledgeSegment.updateOne(
      { _id: failedSegmentId, workspaceId },
      {
        $set: {
          indexStatus: 'rebuild_failed',
          indexErrorCode: 'KNOWLEDGE_MODEL_FAILED',
        },
      },
    );
    const context = await newContext();
    const page = await context.newPage();
    await gotoData(page);
    await playwrightExpect(page.getByText('索引异常').first()).toBeVisible();
    await page.getByRole('button', { name: '编辑数据块 3' }).click();
    const editor = page.locator('.kb2-modal').filter({ hasText: '编辑数据 #3' });
    await page.screenshot({ path: join(resultDir, 'b04-failure-detail.png'), fullPage: true });
    await playwrightExpect(
      editor.getByText('KNOWLEDGE_MODEL_FAILED', { exact: true }),
    ).toBeVisible();
    await playwrightExpect(
      editor.getByRole('button', { name: /训练详情|失败原因|Job/ }),
    ).toBeVisible();
    await context.close();
  });

  it('L1-B04-DATA-003-UI02 hidden product tab pauses indexing polling', async () => {
    const context = await newContext({ hidden: true });
    const page = await context.newPage();
    let listRequests = 0;
    page.on('response', (response) => {
      if (
        response.request().method() === 'GET' &&
        response.url().includes(`/v1/knowledge/sources/${sourceId}/segments`)
      ) {
        listRequests += 1;
      }
    });
    await gotoData(page);
    const initialRequests = listRequests;
    await page.waitForTimeout(11_500);
    expect(listRequests).toBe(initialRequests);
    await page.screenshot({ path: join(resultDir, 'b04-hidden-polling.png'), fullPage: true });
    await context.close();
  });

  it('L1-B04-DATA-003-N03 malformed Job route parameter returns a safe client error', async () => {
    const response = await fetch(`${app.baseUrl}/v1/knowledge/jobs/not-a-job-id`, {
      headers: apiHeaders({ authToken, workspaceId }),
    });
    expect([400, 404]).toContain(response.status);
    const body = await response.text();
    expect(body).not.toMatch(/CastError|ObjectId|BSONError|stack/i);
  });

  it('L1-B04-DATA-001-N03 stale-version Segment delete is rejected instead of deleting the latest content', async () => {
    const current = await api<{ id: string; version: number }>(
      `/v1/knowledge/segments/${indexedSegmentId}`,
      'GET',
    );
    await api(`/v1/knowledge/segments/${indexedSegmentId}`, 'PATCH', {
      question: 'stale delete target updated',
      answer: 'stale delete answer updated',
      version: current.data.version,
    });
    const response = await fetch(`${app.baseUrl}/v1/knowledge/segments/${indexedSegmentId}`, {
      method: 'DELETE',
      headers: {
        ...apiHeaders({
          authToken,
          workspaceId,
          idempotencyKey: `b04-stale-delete-${suffix}`,
        }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ version: current.data.version }),
    });
    expect(response.status).toBe(409);
  });
});
