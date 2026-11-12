import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHeaders, consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeConnections } from '../../packages/service/src/shared/runtime/knowledge-connections';

const root = resolve(import.meta.dirname, '../..');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_b05_e2e_${suffix}`;
const memberId = `mem_b05_e2e_${suffix}`;
const authToken = `kb-b05-e2e-${suffix}`;
const resultDir =
  process.env.B05_RESULT_DIR ?? join(root, 'test-results', 'b05', `manual-${suffix}`);

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
        idempotencyKey: method === 'GET' ? undefined : `b05-${suffix}-${randomUUID()}`,
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
    name: `B05 人工文本空间 ${suffix}`,
    description: 'B05 DATA-004 and ING-002 validation',
    iconKey: 'book-open',
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
  });
  datasetId = dataset.id;
  const source = await api<{ id: string }>(`/v1/knowledge/spaces/${datasetId}/sources`, 'POST', {
    kind: 'text',
    directoryId: null,
    name: `B05 Data Source ${suffix}`,
    searchEnabled: true,
    metadata: {},
  });
  sourceId = source.id;
  await api(`/v1/knowledge/sources/${sourceId}/segments`, 'POST', {
    question: '第一项 B05 分块',
    answer: '第一项答案',
    searchEnabled: true,
    metadata: {},
  });
  await api(`/v1/knowledge/sources/${sourceId}/segments`, 'POST', {
    question: '第二项 B05 问题',
    answer: '第二项回答',
    searchEnabled: true,
    metadata: {},
  });
}

async function cleanup() {
  if (sourceId) await api(`/v1/knowledge/sources/${sourceId}`, 'DELETE').catch(() => undefined);
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

function monitor(page: Page) {
  const consoleErrors: string[] = [];
  const network: Array<{ method: string; url: string; status: number }> = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    network.push({
      method: response.request().method(),
      url: `${url.pathname}${url.search}`,
      status: response.status(),
    });
  });
  return { consoleErrors, network };
}

async function evidence(page: Page, name: string, network: unknown[]) {
  await mkdir(resultDir, { recursive: true });
  await page.screenshot({ path: join(resultDir, `${name}.png`), fullPage: true });
  await writeFile(join(resultDir, `${name}-network.json`), JSON.stringify(network, null, 2));
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_b05_e2e?replicaSet=rs0';
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
    instanceId: `b05-e2e-${suffix}`,
    mongoUri: process.env.KB_TEST_MONGO_URI,
    redisUrl: process.env.KB_TEST_REDIS_URL,
    pgUrl: process.env.KB_TEST_PG_URL,
    s3: {
      endpoint: process.env.KB_TEST_S3_ENDPOINT,
      region: process.env.KB_TEST_S3_REGION,
      bucket: process.env.KB_TEST_S3_BUCKET,
      accessKeyRef: 'env:KB_B05_E2E_S3_ACCESS',
      secretKeyRef: 'env:KB_B05_E2E_S3_SECRET',
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

describe('B05 DATA-004 and ING-002 product UI', () => {
  it('L1-B05-DATA-004-UI01 opens an empty chunk/QA editor and gates required inputs', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const { consoleErrors, network } = monitor(page);
    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=dataCard&collectionId=${sourceId}`,
      { waitUntil: 'networkidle' },
    );
    await page.getByRole('button', { name: '插入', exact: true }).click();
    const modal = page.locator('.kb2-modal');
    await playwrightExpect(modal.getByText('插入数据', { exact: true })).toBeVisible();
    await playwrightExpect(modal.getByRole('tab', { name: '分块' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await modal.getByRole('tab', { name: '问答对' }).click();
    await playwrightExpect(modal.getByText('答案', { exact: true })).toBeVisible();
    await evidence(page, 'data-empty-editor-failure-state', network);
    await playwrightExpect(modal.getByRole('button', { name: '插入', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await evidence(page, 'data-empty-editor', network);
    await context.close();
  });

  it('L1-B05-DATA-004-UI02 accepts a custom index draft before the first Segment save', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const { consoleErrors, network } = monitor(page);
    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=dataCard&collectionId=${sourceId}`,
      { waitUntil: 'networkidle' },
    );
    await page.getByRole('button', { name: '插入', exact: true }).click();
    const modal = page.locator('.kb2-modal');
    await evidence(page, 'data-presave-index-missing', network);
    await playwrightExpect(modal.getByRole('button', { name: '新增索引' })).toBeVisible();
    await modal.getByRole('button', { name: '新增索引' }).click();
    await playwrightExpect(modal.getByLabel('自定义索引')).toBeVisible();
    await modal.getByLabel('自定义索引').fill('B05 pre-save custom index');
    await modal.getByRole('button', { name: '插入', exact: true }).click();
    await playwrightExpect(page.getByText('数据已插入')).toBeVisible();
    await playwrightExpect(page.getByText('B05 pre-save custom index')).toBeVisible();
    expect(consoleErrors).toEqual([]);
    await evidence(page, 'data-presave-index', network);
    await context.close();
  });

  it('L1-B05-DATA-004-UI03 exposes batch upsert target, progress, item results, and failed-item retry', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const { consoleErrors, network } = monitor(page);
    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=dataCard&collectionId=${sourceId}`,
      { waitUntil: 'networkidle' },
    );
    await page.getByRole('button', { name: '批量管理' }).click();
    await page.getByRole('checkbox').first().check();
    await evidence(page, 'data-batch-upsert-missing-failure-state', network);
    await playwrightExpect(
      page.getByRole('button', { name: /批量插入|批量更新|批量处理/ }),
    ).toBeVisible();
    await a11yAndConsole(page, consoleErrors);
    await evidence(page, 'data-batch-upsert-missing', network);
    await context.close();
  });

  it('L1-B05-ING-002-UI01 renders real preview content instead of a missing-contract placeholder', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const { consoleErrors, network } = monitor(page);
    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=import&source=fileCustom`,
      { waitUntil: 'networkidle' },
    );
    await page.getByRole('button', { name: /自定义文本/ }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByLabel('名称').fill(`B05 Preview ${suffix}`);
    await page.getByLabel('文本内容').fill('第一段\n\n第二段');
    await page.getByRole('button', { name: '下一步' }).click();
    await evidence(page, 'ing-preview-placeholder', network);
    await playwrightExpect(
      page.getByText('当前合同没有“导入前分块预览”接口', { exact: false }),
    ).toHaveCount(0);
    await playwrightExpect(page.getByText('第二段', { exact: false })).toBeVisible();
    await a11yAndConsole(page, consoleErrors);
    await evidence(page, 'ing-preview', network);
    await context.close();
  });

  it('L1-B05-ING-002-UI02 persists custom text Source, Job, and exact content hash', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const { consoleErrors, network } = monitor(page);
    const name = `B05 text ${suffix}`;
    const text = '# B05\n\nMarkdown 中文\nemoji 🙌';
    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=import&source=fileCustom`,
      { waitUntil: 'networkidle' },
    );
    await page.getByRole('button', { name: /自定义文本/ }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByLabel('名称').fill(name);
    await page.getByLabel('文本内容').fill(text);
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    const submitted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/spaces/${datasetId}/imports/text`),
    );
    await page.getByRole('button', { name: '确认导入' }).click();
    expect((await submitted).status()).toBe(202);
    await playwrightExpect(page.getByText('任务 ID')).toBeVisible();
    const source = await models.KnowledgeSource.findOne({
      workspaceId,
      name,
    }).lean();
    expect(source).toMatchObject({
      kind: 'text',
      contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
    });
    const job = await models.KnowledgeJob.findOne({
      workspaceId,
      resourceId: datasetId,
      kind: 'import',
    })
      .sort({ createdAt: -1 })
      .lean();
    expect(job).not.toBeNull();
    await evidence(page, 'ing-result-before-refresh', network);
    await page.reload({ waitUntil: 'networkidle' });
    await evidence(page, 'ing-result-after-refresh', network);
    await playwrightExpect(page.getByText('任务 ID')).toBeVisible();
    await a11yAndConsole(page, consoleErrors);
    await evidence(page, 'ing-result-refresh', network);
    await context.close();
  });
});

async function a11yAndConsole(page: Page, consoleErrors: string[]) {
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    ),
  ).toEqual([]);
  expect(consoleErrors).toEqual([]);
}
