import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startB06aApp, type B06aAppHarness } from './b06a-harness';
import { apiHeaders, consoleCookie } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = 'ws_b06a_e2e_' + suffix;
const memberId = 'mem_b06a_e2e_' + suffix;
const authToken = 'b06a-e2e-' + suffix;
const readToken = 'b06a-e2e-read-' + suffix;
const resultDir = join(root, 'test-results', 'b06a', 'b06a-20261113-0058-phaseb', 'e2e');

let app: B06aAppHarness;
let readApp: B06aAppHarness;
let browser: Browser;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let readCookie: Awaited<ReturnType<typeof consoleCookie>>;
let datasetId = '';

function headers(token: string) {
  return apiHeaders({
    authToken: token,
    workspaceId,
    idempotencyKey: 'b06a-e2e-' + randomUUID(),
  });
}

async function api<T = Record<string, unknown>>(
  path: string,
  method: 'GET' | 'POST' | 'PUT',
  body?: unknown,
  baseUrl?: string,
  token?: string,
): Promise<T> {
  const target = baseUrl ?? app.baseUrl;
  const response = await fetch(target + path, {
    method,
    headers: {
      ...headers(token ?? authToken),
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
      method + ' ' + path + ' -> ' + response.status + ' ' + String(payload.error?.code ?? ''),
    );
  }
  return payload.data as T;
}

async function bindModels() {
  const catalog = await api<{
    items: Array<{
      modelId: string;
      displayName: string;
      type: 'llm' | 'embedding' | 'rerank' | 'vlm' | 'stt' | 'tts';
      capabilities: string[];
      authorized: boolean;
    }>;
  }>('/v1/knowledge/models?limit=200', 'GET');
  const selected = catalog.items
    .filter((model) => model.authorized && ['llm', 'embedding', 'rerank'].includes(model.type))
    .filter(
      (model, index, rows) =>
        rows.findIndex((candidate) => candidate.type === model.type) === index,
    );
  const space = await api<{ version: number }>('/v1/knowledge/spaces/' + datasetId, 'GET');
  await api('/v1/knowledge/spaces/' + datasetId + '/model-bindings', 'PUT', {
    bindings: selected.map((model) => ({
      modelType: model.type,
      modelId: model.modelId,
      displayName: model.displayName,
      requiredCapabilities: model.capabilities,
      status: 'active',
    })),
    version: space.version,
  });
}

async function waitForJob(
  jobId: string,
  timeoutMs = 90_000,
): Promise<{ status: string; job: unknown }> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const job = await api<{ status: string }>('/v1/knowledge/jobs/' + jobId, 'GET');
    last = job;
    if (['succeeded', 'failed', 'cancelled', 'dead_letter'].includes(job.status)) {
      return { status: job.status, job };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  return { status: 'timeout', job: last };
}

async function sources(): Promise<Array<{ id: string; name: string; processingStatus: string }>> {
  const page = await api<{ items: Array<{ id: string; name: string; processingStatus: string }> }>(
    '/v1/knowledge/spaces/' + datasetId + '/sources?limit=100',
    'GET',
  );
  return page.items;
}

async function uploadAndImport(input: {
  name: string;
  mimeType: string;
  body: Buffer;
}): Promise<void> {
  const session = await api<{ uploadId: string }>('/v1/knowledge/uploads', 'POST', {
    knowledgeSpaceId: datasetId,
    name: input.name,
    mimeType: input.mimeType,
    sizeBytes: input.body.byteLength,
  });
  const presigned = await api<{ uploads: Array<{ url: string; headers: Record<string, string> }> }>(
    '/v1/knowledge/uploads/' + session.uploadId + '/presign',
    'POST',
    { partNumbers: [1] },
  );
  const put = await fetch(presigned.uploads[0]!.url, {
    method: 'PUT',
    headers: presigned.uploads[0]!.headers,
    body: input.body,
  });
  expect(put.status).toBe(200);
  await fetch(app.baseUrl + '/v1/knowledge/uploads/' + session.uploadId + '/complete', {
    method: 'POST',
    headers: { ...headers(authToken), 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [] }),
  }).then(async (response) => {
    expect(response.status).toBe(200);
  });
  await api('/v1/knowledge/spaces/' + datasetId + '/imports/files', 'POST', {
    uploadIds: [session.uploadId],
    parseProvider: 'liteparse',
    parseConfig: {},
    chunking: {
      trainingType: input.mimeType.startsWith('image/') ? 'imageParse' : 'chunk',
      chunkSettingMode: 'auto',
    },
  });
}

async function openImport(page: Page) {
  await page.goto(
    app.baseUrl + '/dataset/detail?datasetId=' + datasetId + '&currentTab=import&source=fileCustom',
    { waitUntil: 'networkidle' },
  );
  await page.getByRole('button', { name: /本地文件/ }).click();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.locator('input[type="file"]').waitFor();
}

async function shot(page: Page, name: string) {
  await mkdir(resultDir, { recursive: true });
  await page.screenshot({ path: join(resultDir, name), fullPage: true });
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_b06a_e2e?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-test';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';

  app = await startB06aApp({ suffix, workspaceId, memberId, authToken, withWorker: true });
  readApp = await startB06aApp({
    suffix: suffix + 'read',
    workspaceId,
    memberId: memberId + 'read',
    authToken: readToken,
    scopes: 'knowledge:read',
    isWorkspaceOwner: false,
    withWorker: false,
  });
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
  readCookie = await consoleCookie({ baseUrl: readApp.baseUrl, authToken: readToken, workspaceId });
  const dataset = await api<{ id: string }>('/v1/knowledge/spaces', 'POST', {
    kind: 'space',
    parentSpaceId: null,
    name: 'B06A E2E ' + suffix,
    description: 'B06A upload and source validation',
    iconKey: 'book-open',
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
  });
  datasetId = dataset.id;
  await bindModels();
  await mkdir(resultDir, { recursive: true });
  browser = await chromium.launch({ headless: true });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await readApp?.close();
}, 60_000);

describe('L1-B06-ING-001 product upload flow', () => {
  it('B06B-FILE-003-001 Upload Complete exposes only public blob fields', async () => {
    const name = 'b06b-dto-' + suffix + '.txt';
    const session = await api<{ uploadId: string }>('/v1/knowledge/uploads', 'POST', {
      knowledgeSpaceId: datasetId,
      name,
      mimeType: 'text/plain',
      sizeBytes: Buffer.byteLength('public dto body'),
    });
    const presigned = await api<{
      uploads: Array<{ url: string; headers: Record<string, string> }>;
    }>('/v1/knowledge/uploads/' + session.uploadId + '/presign', 'POST', { partNumbers: [1] });
    const put = await fetch(presigned.uploads[0]!.url, {
      method: 'PUT',
      headers: presigned.uploads[0]!.headers,
      body: Buffer.from('public dto body'),
    });
    expect(put.status).toBe(200);
    const completed = await fetch(
      app.baseUrl + '/v1/knowledge/uploads/' + session.uploadId + '/complete',
      {
        method: 'POST',
        headers: { ...headers(authToken), 'content-type': 'application/json' },
        body: JSON.stringify({ parts: [] }),
      },
    );
    const payload = (await completed.json()) as {
      data: Record<string, unknown>;
    };
    expect(completed.status).toBe(200);
    expect(Object.keys(payload.data).sort()).toEqual(
      ['blobId', 'etag', 'sizeBytes', 'state', 'workspaceId'].sort(),
    );
    expect(JSON.stringify(payload)).not.toMatch(/"bucket"|"objectKey"|kb-test\/ws\//);
  });

  it('L1-B06-ING-001-P01 L1-B06-ING-001-UI01 上传文本文件由真实 Worker 完成解析并在刷新后可见', async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const name = 'b06a-e2e-' + suffix + '.txt';
    await openImport(page);
    await page.locator('input[type="file"]').setInputFiles({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from('B06A e2e upload body ' + suffix, 'utf8'),
    });
    await playwrightExpect(page.getByText('completed', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await playwrightExpect(page.getByText(name, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/spaces/' + datasetId + '/imports/files'),
    );
    await page.getByRole('button', { name: '确认导入' }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(202);
    const payload = (await response.json()) as { data: { jobId: string } };
    const jobId = payload.data.jobId;
    const settled = await waitForJob(jobId);
    let childEvidence = '';
    const childIds =
      (settled.job as { result?: { childJobIds?: string[] } }).result?.childJobIds ?? [];
    for (const childId of childIds) {
      const child = await api<Record<string, unknown>>('/v1/knowledge/jobs/' + childId, 'GET');
      childEvidence +=
        ' child[' +
        childId +
        ']=' +
        JSON.stringify({ status: child.status, error: child.error, progress: child.progress });
    }
    expect(settled.status, 'job=' + JSON.stringify(settled.job) + childEvidence).toBe('succeeded');

    const created = (await sources()).find((source) => source.name === name);
    expect(created).toBeDefined();
    expect(['ready', 'partial']).toContain(created!.processingStatus);

    await page.getByRole('button', { name: '返回 Collection' }).first().click();
    await page.getByRole('tab', { name: '数据集' }).click();
    await page.reload({ waitUntil: 'networkidle' });
    await playwrightExpect(page.getByText(name, { exact: true })).toBeVisible({ timeout: 30_000 });
    await shot(page, 'p01-source-after-reload.png');
    await context.close();
  }, 240_000);

  it('L1-B06-ING-001-N01 一成功一失败时失败行保留逐行原因且仅成功项可继续', async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    let uploadInitCount = 0;
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/v1/knowledge/uploads'
      ) {
        uploadInitCount += 1;
      }
    });
    const goodName = 'b06a-mixed-' + suffix + '.txt';
    const badName = 'b06a-mixed-' + suffix + '.exe';
    await openImport(page);
    await page.locator('input[type="file"]').setInputFiles([
      { name: goodName, mimeType: 'text/plain', buffer: Buffer.from('mixed body', 'utf8') },
      { name: badName, mimeType: 'application/octet-stream', buffer: Buffer.from('MZ', 'utf8') },
    ]);
    await playwrightExpect(page.getByText(goodName, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await playwrightExpect(page.getByText(badName, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const badRow = page.locator('.kb2-upload-row').filter({ hasText: badName });
    await playwrightExpect(badRow.getByRole('button', { name: '重试' })).toBeVisible({
      timeout: 60_000,
    });
    await shot(page, 'n01-mixed-upload.png');
    const badRowText = await badRow.innerText().catch(() => '');
    const nextEnabledWithSuccess = await page.getByRole('button', { name: '下一步' }).isEnabled();
    const initCountBeforeRetry = uploadInitCount;
    await badRow.getByRole('button', { name: '重试' }).click();
    await playwrightExpect
      .poll(() => uploadInitCount, { timeout: 30_000 })
      .toBe(initCountBeforeRetry + 1);
    await playwrightExpect(badRow).toContainText(badName);
    await context.close();

    const onlyBad = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await onlyBad.addCookies([cookie]);
    const onlyBadPage = await onlyBad.newPage();
    onlyBadPage.setDefaultTimeout(30_000);
    await openImport(onlyBadPage);
    await onlyBadPage.locator('input[type="file"]').setInputFiles([
      {
        name: 'b06a-only-bad-' + suffix + '.exe',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('MZ', 'utf8'),
      },
    ]);
    await playwrightExpect(
      onlyBadPage.locator('.kb2-upload-row').filter({ hasText: '.exe' }),
    ).toBeVisible({ timeout: 30_000 });
    await shot(onlyBadPage, 'n01-failed-only.png');
    const nextDisabledWhenAllFailed = await onlyBadPage
      .getByRole('button', { name: '下一步' })
      .isDisabled();
    await onlyBad.close();
    expect(
      {
        perRowReason: /不受支持|不支持|失败|无法|KNOWLEDGE_/i.test(badRowText),
        nextEnabledWithSuccess,
        nextDisabledWhenAllFailed,
      },
      'N01 evidence: per-row reason (KB-IMPORT-028), next gating (KB-IMPORT-029)',
    ).toEqual({
      perRowReason: true,
      nextEnabledWithSuccess: true,
      nextDisabledWhenAllFailed: true,
    });
  }, 240_000);

  it('L1-B06-FILE-001-UI01 上传中取消会中止服务端会话且不创建 Source', async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const name = 'b06a-cancel-' + suffix + '.txt';
    const survivingName = 'b06a-cancel-survives-' + suffix + '.txt';
    await page.route('http://127.0.0.1:9000/**', async (route) => {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
      await route.continue();
    });
    await openImport(page);
    const initPromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/v1/knowledge/uploads'),
    );
    await page.locator('input[type="file"]').setInputFiles([
      {
        name,
        mimeType: 'text/plain',
        buffer: Buffer.alloc(9 * 1024 * 1024, 0x61),
      },
      {
        name: survivingName,
        mimeType: 'text/plain',
        buffer: Buffer.alloc(9 * 1024 * 1024, 0x62),
      },
    ]);
    const init = await initPromise;
    const initPayload = (await init.json()) as { data: { uploadId: string } };
    const uploadId = initPayload.data.uploadId;
    const cancel = page.getByRole('button', { name: '取消上传 ' + name });
    await playwrightExpect(cancel).toBeVisible({ timeout: 15_000 });
    const survivingInitPromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/v1/knowledge/uploads'),
    );
    await cancel.click();
    const survivingInit = await survivingInitPromise;
    const survivingId = ((await survivingInit.json()) as { data: { uploadId: string } }).data
      .uploadId;
    const survivingRow = page.locator('.kb2-upload-row').filter({ hasText: survivingName });
    await playwrightExpect(survivingRow.getByText('completed', { exact: true })).toBeVisible({
      timeout: 60_000,
    });

    let status = '';
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const session = await api<{ status: string }>('/v1/knowledge/uploads/' + uploadId, 'GET');
      status = session.status;
      if (status === 'aborted') break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
    await shot(page, 'file001-cancel-upload.png');
    expect(status, 'cancel during upload must abort the server session').toBe('aborted');
    expect(
      (await api<{ status: string }>('/v1/knowledge/uploads/' + survivingId, 'GET')).status,
    ).toBe('completed');
    expect((await sources()).some((source) => source.name === name)).toBe(false);
    expect((await sources()).some((source) => source.name === survivingName)).toBe(false);
    await context.close();
  }, 240_000);

  it('L1-B06-FILE-001-UI01 删除已完成上传行不创建 Source 且服务端保留 completed 事实', async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const name = 'b06a-delete-' + suffix + '.txt';
    await openImport(page);
    const initPromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/v1/knowledge/uploads'),
    );
    await page.locator('input[type="file"]').setInputFiles({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from('delete me body', 'utf8'),
    });
    const init = await initPromise;
    const initPayload = (await init.json()) as { data: { uploadId: string } };
    const uploadId = initPayload.data.uploadId;
    await playwrightExpect(page.getByText('completed', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const row = page.locator('.kb2-upload-row').filter({ hasText: name });
    await row.locator('button').click();
    await playwrightExpect(page.getByText(name, { exact: true })).toHaveCount(0);
    const session = await api<{ status: string }>('/v1/knowledge/uploads/' + uploadId, 'GET');
    expect(
      session.status,
      'removing a finished row is a list edit, not an abort (FastGPT RenderFiles.tsx:90-98)',
    ).toBe('completed');
    expect((await sources()).some((source) => source.name === name)).toBe(false);
    await context.close();
  }, 180_000);

  it('L1-B06-FILE-003-UI01 只读成员可预览并下载原文且短链不含对象键', async () => {
    const created = (await sources())[0];
    expect(created).toBeDefined();

    const previewResponse = await fetch(
      readApp.baseUrl + '/v1/knowledge/sources/' + created!.id + '/preview',
      { headers: headers(readToken) },
    );
    const previewBody = (await previewResponse.json().catch(() => ({}))) as {
      success?: boolean;
      error?: { code?: string };
    };
    expect(
      previewResponse.status,
      'read member preview -> ' + JSON.stringify(previewBody.error ?? null),
    ).toBe(200);

    const downloadResponse = await fetch(
      readApp.baseUrl + '/v1/knowledge/sources/' + created!.id + '/download',
      {
        method: 'POST',
        headers: { ...headers(readToken), 'content-type': 'application/json' },
        body: JSON.stringify({ disposition: 'attachment' }),
      },
    );
    const downloadBody = (await downloadResponse.json().catch(() => ({}))) as {
      success?: boolean;
      data?: { url?: string; expiresAt?: string };
      error?: { code?: string };
    };
    const downloadStatus = downloadResponse.status;
    const ticketUrl = downloadBody.data?.url ?? '';
    const ticketWithoutAuth = await fetch(ticketUrl);
    expect(ticketWithoutAuth.status).toBe(401);
    const ticketWithReadSession = await fetch(ticketUrl, {
      headers: { cookie: `${readCookie.name}=${readCookie.value}` },
    });
    expect(ticketWithReadSession.status).toBe(200);
    expect((await ticketWithReadSession.text()).length).toBeGreaterThan(0);

    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([readCookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const networkUrls: string[] = [];
    page.on('request', (request) => networkUrls.push(request.url()));
    await page.goto(readApp.baseUrl + '/dataset/detail?datasetId=' + datasetId, {
      waitUntil: 'networkidle',
    });
    const row = page.getByRole('row').filter({ hasText: created!.name });
    await playwrightExpect(row).toHaveCount(1);
    await shot(page, 'file003-readonly-detail.png');
    const previewEntry = row.getByRole('button', { name: '预览' });
    const previewEntryCount = await previewEntry.count();
    const downloadEntryCount = await row.getByRole('button', { name: /更多操作|下载/ }).count();
    expect(
      {
        previewStatus: previewResponse.status,
        downloadStatus,
        downloadError: downloadBody.error?.code ?? null,
        previewEntryCount,
        downloadEntryCount,
      },
      'FILE-003-UI01 evidence: read member preview/api, download/api and row entries',
    ).toEqual({
      previewStatus: 200,
      downloadStatus: 200,
      downloadError: null,
      previewEntryCount: 1,
      downloadEntryCount: 1,
    });
    await previewEntry.click();
    const dialog = page.getByRole('dialog', { name: /预览原始内容/ });
    await playwrightExpect(dialog).toBeVisible();
    await playwrightExpect(dialog.getByText(/B06A e2e upload body/i)).toBeVisible();
    await dialog.getByRole('button', { name: '关闭弹窗' }).click();
    await playwrightExpect(previewEntry).toBeFocused();
    await row.getByRole('button', { name: /更多操作/ }).click();
    await playwrightExpect(row.getByRole('menuitem', { name: /下载原始文件/ })).toBeVisible();
    expect(ticketUrl).toContain('/v1/knowledge/files/');
    for (const url of [...networkUrls, ticketUrl]) {
      expect(url).not.toContain('source/unbound');
      expect(url).not.toContain('kb-test/ws/');
      expect(url).not.toContain('X-Amz-Security-Token');
    }
    expect(JSON.stringify(downloadBody)).not.toContain('kb-test/ws/');
    await context.close();
  }, 240_000);

  it('L1-B06-FILE-003-UI01 图片预览失败后可重新获取 ticket 并恢复', async () => {
    const name = 'b06a-image-' + suffix + '.png';
    await uploadAndImport({
      name,
      mimeType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    });
    await playwrightExpect
      .poll(async () => (await sources()).some((source) => source.name === name), {
        timeout: 30_000,
      })
      .toBe(true);

    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([readCookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    let failFirstContent = true;
    await page.route(/\/v1\/knowledge\/files\/[^/]+\/content/, async (route) => {
      if (!failFirstContent) {
        await route.continue();
        return;
      }
      failFirstContent = false;
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: { code: 'KNOWLEDGE_FORBIDDEN' } }),
      });
    });
    await page.goto(readApp.baseUrl + '/dataset/detail?datasetId=' + datasetId, {
      waitUntil: 'networkidle',
    });
    const row = page.getByRole('row').filter({ hasText: name });
    const trigger = row.getByRole('button', { name: '预览' });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await shot(page, 'file003-image-preview.png');
    await playwrightExpect(dialog.getByRole('button', { name: '重新获取预览链接' })).toBeVisible();
    await dialog.getByRole('button', { name: '重新获取预览链接' }).click();
    const image = dialog.getByRole('img', { name: `${name} 图片预览` });
    await playwrightExpect(image).toBeVisible();
    await playwrightExpect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
    await dialog.getByRole('button', { name: '关闭弹窗' }).click();
    await playwrightExpect(trigger).toBeFocused();
    await context.close();
  }, 240_000);

  it('L1-B06-FILE-003-UI01 空 rawText 显示明确空态而不是空白弹窗', async () => {
    const name = 'b06a-empty-' + suffix + '.txt';
    await uploadAndImport({
      name,
      mimeType: 'text/plain',
      body: Buffer.from('   \n\t', 'utf8'),
    });
    await playwrightExpect
      .poll(async () => (await sources()).some((source) => source.name === name), {
        timeout: 30_000,
      })
      .toBe(true);

    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([readCookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(readApp.baseUrl + '/dataset/detail?datasetId=' + datasetId, {
      waitUntil: 'networkidle',
    });
    const row = page.getByRole('row').filter({ hasText: name });
    await row.getByRole('button', { name: '预览' }).click();
    const dialog = page.getByRole('dialog');
    await playwrightExpect(dialog.getByText('暂无可预览文本')).toBeVisible();
    await shot(page, 'file003-empty-raw-text.png');
    await context.close();
  }, 180_000);

  it('TEST-X-FRONTEND-A11Y TEST-X-SECRET-LEAK TEST-X-SCOPE-GUARD 导入页满足可访问性与范围守卫', async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const sameOriginUrls: string[] = [];
    const sameOriginBodies: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith(app.baseUrl)) sameOriginUrls.push(request.url());
    });
    page.on('response', async (response) => {
      if (!response.url().startsWith(app.baseUrl)) return;
      const type = response.headers()['content-type'] ?? '';
      if (type.includes('application/json')) {
        sameOriginBodies.push(await response.text().catch(() => ''));
      }
    });
    await page.goto(app.baseUrl + '/dataset/detail?datasetId=' + datasetId + '&currentTab=import', {
      waitUntil: 'networkidle',
    });
    const accessibility = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const blocking = accessibility.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    const text = await page.locator('body').innerText();
    const secret = process.env.KB_TEST_S3_SECRET_KEY ?? 'minioadmin';
    const scopeForbiddenFound = ['归档 ZIP', '孤儿对象对账', '生命周期 TTL 清理'].filter((item) =>
      text.includes(item),
    );
    const urlLeaks = sameOriginUrls.filter(
      (url) => url.includes('source/unbound') || url.includes('kb-test/ws/'),
    );
    const bodyLeaks = sameOriginBodies.filter(
      (body) => body.includes('source/unbound') || body.includes(secret),
    );
    await shot(page, 'import-a11y-1200.png');
    expect(
      {
        violations: blocking.map(
          (violation) => violation.id + '@' + violation.nodes[0]?.target?.join(' '),
        ),
        scopeForbiddenFound,
        urlLeakSample: urlLeaks.slice(0, 3),
        bodyLeakCount: bodyLeaks.length,
      },
      'TEST-X-FRONTEND-A11Y / TEST-X-SECRET-LEAK / TEST-X-SCOPE-GUARD evidence',
    ).toEqual({
      violations: [],
      scopeForbiddenFound: [],
      urlLeakSample: [],
      bodyLeakCount: 0,
    });
    await context.close();
  }, 180_000);
});
