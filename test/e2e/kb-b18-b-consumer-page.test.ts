import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiKey,
  cleanupWorkspaceObjects,
  createSourceAndSegment,
  createSpace,
  delayedProvider,
  openConnections,
  partialProvider,
  redact,
  seedIndexedSegment,
  setEmbeddingBinding,
  startB18App,
  startConsumerPage,
  suffix as uniqueSuffix,
  writeJson,
  type B18AppHarness,
} from '../fixtures/b18-b/support';
import {
  registerKnowledgeModels,
  type KnowledgeConnections,
  type TenantContext,
} from '../../packages/service/src';

const root = resolve(import.meta.dirname, '../..');
const runId = process.env.B18_RUN_ID?.trim() || `page-${Date.now()}`;
const evidenceDir = join(root, 'test-results', 'b18-b', runId, 'ui');
const suffix = uniqueSuffix('page');
const workspaceId = `ws_${suffix}`;
const memberId = `mem_${suffix}`;
const adminToken = `b18b-page-auth-${suffix}`;
const secrets: string[] = [];

let app: B18AppHarness;
let timeoutApp: B18AppHarness;
let provider: Awaited<ReturnType<typeof delayedProvider>>;
let partialApp: B18AppHarness;
let partialProviderServer: Awaited<ReturnType<typeof partialProvider>>;
let connections: KnowledgeConnections;
let browser: Browser;
let spaceId = '';
let partialSpaceId = '';
let searchKey = '';
let readOnlyKey = '';

async function attachNetworkGuard(page: Awaited<ReturnType<Browser['newPage']>>) {
  const requests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}`);
    const allowed =
      url.pathname === '/' ||
      url.pathname === '/consumer-page.html' ||
      url.pathname.startsWith('/v1/knowledge/');
    expect(allowed, `unexpected browser network target: ${url.href}`).toBe(true);
    expect(request.headers().authorization).toBeUndefined();
    expect(request.url()).not.toContain('kn_live_');
  });
  return requests;
}

async function openPage(
  pageUrl: string,
  query: Record<string, string>,
): Promise<{
  page: Awaited<ReturnType<Browser['newPage']>>;
  requests: string[];
}> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    colorScheme: 'light',
  });
  const page = await context.newPage();
  const requests = await attachNetworkGuard(page);
  const url = new URL(pageUrl);
  for (const [key, value] of Object.entries({ workspaceId, ...query })) {
    url.searchParams.set(key, value);
  }
  await page.goto(url.toString(), { waitUntil: 'networkidle' });
  return { page, requests };
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_b18b_ui?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-test';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';

  app = await startB18App({
    suffix,
    workspaceId,
    memberId,
    authToken: adminToken,
  });
  connections = await openConnections();
  const mainSpace = await createSpace(app, {
    adminToken,
    workspaceId,
    suffix: `${suffix}-main`,
  });
  const partialSpace = await createSpace(app, {
    adminToken,
    workspaceId,
    suffix: `${suffix}-partial`,
  });
  spaceId = mainSpace.id;
  partialSpaceId = partialSpace.id;
  const material = await createSourceAndSegment(app, {
    adminToken,
    workspaceId,
    spaceId,
    suffix: `${suffix}-source`,
    title: `B18B UI refund ${suffix}`,
    text: 'Refund policy UI body: refunds take five business days.',
  });
  const context: TenantContext = {
    workspaceId,
    memberId,
    requestId: `seed-${suffix}`,
    traceId: suffix.padEnd(32, '0').slice(0, 32),
    scopes: ['knowledge:read', 'knowledge:search', 'knowledge:write'],
    isWorkspaceOwner: true,
  };
  await seedIndexedSegment(connections, context, {
    spaceId,
    segmentId: material.segmentId,
    text: 'Refund policy UI body: refunds take five business days.',
    label: 'UI',
  });
  await createSourceAndSegment(app, {
    adminToken,
    workspaceId,
    spaceId: partialSpaceId,
    suffix: `${suffix}-partial-source`,
    title: `B18B UI partial ${suffix}`,
    text: 'Partial UI source.',
  });
  const search = await createApiKey(app, {
    adminToken,
    workspaceId,
    suffix: `${suffix}-search`,
    scopes: ['knowledge:read', 'knowledge:search'],
    spaceIds: [spaceId, partialSpaceId],
  });
  const read = await createApiKey(app, {
    adminToken,
    workspaceId,
    suffix: `${suffix}-read`,
    scopes: ['knowledge:read'],
    spaceIds: [spaceId],
  });
  searchKey = search.secret;
  readOnlyKey = read.secret;
  secrets.push(searchKey, readOnlyKey);

  partialProviderServer = await partialProvider();
  partialApp = await startB18App({
    suffix: `${suffix}-partial`,
    workspaceId,
    memberId,
    authToken: adminToken,
    modelMode: 'real',
    aiproxyBaseUrl: partialProviderServer.baseUrl,
  });
  await setEmbeddingBinding(connections, context, {
    spaceId: partialSpaceId,
    modelId: 'mock-embedding-1024',
    dimension: 1024,
  });

  provider = await delayedProvider({ delayMs: 35_000 });
  timeoutApp = await startB18App({
    suffix: `${suffix}-timeout`,
    workspaceId,
    memberId,
    authToken: adminToken,
    modelMode: 'real',
    aiproxyBaseUrl: provider.baseUrl,
  });
  browser = await chromium.launch({ headless: true });
}, 300_000);

afterAll(async () => {
  const objectCleanup = connections
    ? await cleanupWorkspaceObjects(connections, workspaceId)
    : { refs: 0, deleted: 0, failed: 0 };
  writeJson(join(evidenceDir, 'ui-runtime.json'), {
    runId,
    workspaceId,
    appOutput: redact(app?.output() ?? '', secrets),
    timeoutAppOutput: redact(timeoutApp?.output() ?? '', secrets),
    partialAppOutput: redact(partialApp?.output() ?? '', secrets),
    providerMode: 'BLOCKED_PROVIDER',
    objectCleanup,
  });
  await browser?.close();
  if (connections) {
    const models = registerKnowledgeModels(connections.mongo);
    for (const model of Object.values(models)) await model.deleteMany({ workspaceId });
    for (const table of [
      'knowledge_segment_vectors_768',
      'knowledge_segment_vectors_1024',
      'knowledge_segment_vectors_1536',
      'knowledge_segment_vectors_3072',
    ]) {
      await connections.pg.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
    }
    await connections.close();
  }
  await timeoutApp?.close();
  await partialApp?.close();
  await partialProviderServer?.close();
  await provider?.close();
  await app?.close();
}, 120_000);

describe('L1-B18-B test-owned consumer page', () => {
  it('renders and restores Workflow, Agent and Chat references', async () => {
    const partialServer = await startConsumerPage({
      appBaseUrl: partialApp.baseUrl,
      workspaceId,
      apiKey: searchKey,
    });
    const server = await startConsumerPage({
      appBaseUrl: app.baseUrl,
      workspaceId,
      apiKey: searchKey,
    });
    try {
      const partial = await openPage(partialServer.baseUrl, {
        role: 'workflow',
        query: 'refund policy',
        spaceId,
        spaceIds: `${spaceId},${partialSpaceId}`,
        tokenBudget: '5000',
      });
      await partial.page.getByRole('button', { name: '运行检索' }).click();
      await playwrightExpect(partial.page.getByRole('status')).toHaveText(/部分空间失败/);
      await partial.page.close();

      const { page, requests } = await openPage(server.baseUrl, {
        role: 'agent',
        query: 'refund policy',
        spaceId,
        spaceIds: `${spaceId},${partialSpaceId}`,
        tokenBudget: '5000',
      });
      await playwrightExpect(page.getByText('B18 下游消费测试')).toBeVisible();
      await page.getByRole('button', { name: '运行检索' }).click();
      await playwrightExpect(page.getByRole('status')).toHaveText(/检索成功/);
      await playwrightExpect(page.locator('article').first()).toBeVisible();
      await page.locator('details').first().locator('summary').click();
      await playwrightExpect(page.getByText('Citation ID')).toBeVisible();

      await page.locator('#role').selectOption('chat');
      await page.getByRole('button', { name: '运行检索' }).click();
      await playwrightExpect(page.getByRole('status')).toHaveText(/检索成功/);
      await page.reload({ waitUntil: 'networkidle' });
      await playwrightExpect(page.getByRole('status')).toHaveText(/引用已恢复/);
      await playwrightExpect(page.locator('article').first()).toBeVisible();
      await playwrightExpect(page.locator('article').first()).toHaveAttribute(
        'data-restored',
        'true',
      );

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      const axe = await new AxeBuilder({ page }).analyze();
      expect(
        axe.violations.filter((entry) => entry.impact === 'serious' || entry.impact === 'critical'),
      ).toEqual([]);
      await page.screenshot({
        path: join(evidenceDir, 'workflow-agent-chat-1440.png'),
        fullPage: true,
      });
      expect(
        requests.filter((entry) => entry.startsWith('GET /') || entry.startsWith('POST /')),
      ).toEqual(expect.arrayContaining(['GET /', 'POST /v1/knowledge/search/semantic']));
      await page.close();
    } finally {
      await partialServer.close();
      await server.close();
    }
  }, 180_000);

  it('renders empty and permission failures without internal details', async () => {
    const searchServer = await startConsumerPage({
      appBaseUrl: app.baseUrl,
      workspaceId,
      apiKey: searchKey,
    });
    const deniedServer = await startConsumerPage({
      appBaseUrl: app.baseUrl,
      workspaceId,
      apiKey: readOnlyKey,
    });
    const unauthorizedServer = await startConsumerPage({
      appBaseUrl: app.baseUrl,
      workspaceId,
      apiKey: `kn_live_${'z'.repeat(48)}`,
    });
    try {
      const empty = await openPage(searchServer.baseUrl, {
        role: 'chat',
        query: `missing-${suffix}`,
        spaceId: partialSpaceId,
      });
      await empty.page.getByRole('button', { name: '运行检索' }).click();
      await playwrightExpect(empty.page.getByRole('status')).toHaveText(/空命中/);
      const forbidden = await openPage(deniedServer.baseUrl, {
        role: 'agent',
        query: 'refund',
        spaceId,
      });
      await forbidden.page.getByRole('button', { name: '运行检索' }).click();
      await playwrightExpect(forbidden.page.getByRole('status')).toHaveText(/请求失败/);
      await playwrightExpect(forbidden.page.getByRole('alert')).toContainText('无权访问');
      await playwrightExpect(forbidden.page.getByRole('alert')).not.toContainText(
        /mongo|redis|postgres|stack|objectKey/i,
      );
      const unauthorized = await openPage(unauthorizedServer.baseUrl, {
        role: 'chat',
        query: 'refund',
        spaceId,
      });
      await unauthorized.page.getByRole('button', { name: '运行检索' }).click();
      await playwrightExpect(unauthorized.page.getByRole('alert')).toContainText('认证失败');
      await empty.page.close();
      await forbidden.page.close();
      await unauthorized.page.close();
    } finally {
      await searchServer.close();
      await deniedServer.close();
      await unauthorizedServer.close();
    }
  }, 180_000);

  it('renders 429 and controlled 504 as distinct retryable states', async () => {
    const rateKey = `kb-rate:${workspaceId}:API-SEARCH-HYBRID`;
    await connections.redis.hset(rateKey, 'tokens', '0', 'timestamp', String(Date.now() + 30_000));
    await connections.redis.pexpire(rateKey, 30_000);
    const limiterPage = await startConsumerPage({
      appBaseUrl: app.baseUrl,
      workspaceId,
      apiKey: searchKey,
    });
    const timeoutPage = await startConsumerPage({
      appBaseUrl: timeoutApp.baseUrl,
      workspaceId,
      apiKey: searchKey,
    });
    try {
      const limited = await openPage(limiterPage.baseUrl, {
        role: 'chat',
        query: 'refund',
        spaceId,
      });
      await limited.page.getByRole('button', { name: '运行检索' }).click();
      await playwrightExpect(limited.page.getByRole('status')).toHaveText(/请求失败/);
      await playwrightExpect(limited.page.getByRole('alert')).toContainText('请求过于频繁');

      await connections.redis.del(rateKey);
      const timeout = await openPage(timeoutPage.baseUrl, {
        role: 'chat',
        query: 'refund',
        spaceId,
      });
      await timeout.page.getByRole('button', { name: '运行检索' }).click({
        timeout: 15_000,
      });
      await playwrightExpect(timeout.page.getByRole('status')).toHaveText(/依赖超时/, {
        timeout: 45_000,
      });
      await playwrightExpect(timeout.page.getByRole('alert')).toContainText('可重试');
      await timeout.page.screenshot({
        path: join(evidenceDir, 'timeout-1440.png'),
        fullPage: true,
      });
      await limited.page.close();
      await timeout.page.close();
    } finally {
      await limiterPage.close();
      await timeoutPage.close();
    }
  }, 180_000);
});
