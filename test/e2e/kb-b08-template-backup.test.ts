import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { apiHeaders, consoleCookie } from './s4-app-harness';
import { startB06aApp, type B06aAppHarness } from './b06a-harness';

const XLSX = createRequire(new URL('../../packages/parse/package.json', import.meta.url))(
  'xlsx',
) as {
  utils: {
    book_new(): unknown;
    aoa_to_sheet(rows: unknown[][]): unknown;
    book_append_sheet(workbook: unknown, worksheet: unknown, name: string): void;
  };
  write(workbook: unknown, options: { type: 'array'; bookType: 'xlsx' }): ArrayBuffer;
};

const root = resolve(import.meta.dirname, '../..');
const runId =
  process.env.KB_B08_RUN_ID?.trim() ||
  `b08-${new Date()
    .toISOString()
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/, 'Z')}-${randomUUID().slice(0, 8)}`;
const resultDir = join(root, 'test-results', 'b08', runId);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b08_e2e_${suffix}`;
const memberId = `mem_b08_e2e_${suffix}`;
const authToken = `b08-e2e-${suffix}`;

let app: B06aAppHarness;
let browser: Browser;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let spaceId = '';

function headers(key = `b08-${suffix}-${randomUUID()}`) {
  return apiHeaders({ authToken, workspaceId, idempotencyKey: key });
}

async function rawApi(path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown, key?: string) {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...headers(key),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { response, payload };
}

async function api<T>(path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<T> {
  const result = await rawApi(path, method, body);
  if (!result.response.ok || result.payload.success !== true) {
    throw new Error(
      `${method} ${path} failed: ${result.response.status} ${JSON.stringify(result.payload)}`,
    );
  }
  return result.payload.data as T;
}

async function uploadFile(input: {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<{ uploadId: string; completeStatus: number; completeBody: Record<string, unknown> }> {
  const session = await api<{ uploadId: string }>('/v1/knowledge/uploads', 'POST', {
    knowledgeSpaceId: spaceId,
    name: input.name,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.byteLength,
  });
  const presigned = await api<{
    uploads: Array<{ url: string; headers: Record<string, string> }>;
  }>(`/v1/knowledge/uploads/${session.uploadId}/presign`, 'POST', { partNumbers: [1] });
  const part = presigned.uploads[0];
  if (!part) throw new Error('presign did not return part 1');
  const put = await fetch(part.url, {
    method: 'PUT',
    headers: part.headers,
    body: input.bytes,
  });
  expect(put.status).toBe(200);
  const completed = await rawApi(`/v1/knowledge/uploads/${session.uploadId}/complete`, 'POST', {
    parts: [],
  });
  return {
    uploadId: session.uploadId,
    completeStatus: completed.response.status,
    completeBody: completed.payload,
  };
}

async function waitForJob(jobId: string, timeoutMs = 120_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    last = await api<Record<string, unknown>>(`/v1/knowledge/jobs/${jobId}`, 'GET');
    if (['succeeded', 'failed', 'dead_letter', 'cancelled'].includes(String(last.status))) {
      return last;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  }
  return last;
}

async function listSources(): Promise<
  Array<{ id: string; name: string; kind: string; processingStatus: string }>
> {
  const page = await api<{
    items: Array<{ id: string; name: string; kind: string; processingStatus: string }>;
  }>(`/v1/knowledge/spaces/${spaceId}/sources?limit=100`, 'GET');
  return page.items;
}

async function listSegments(sourceId: string): Promise<
  Array<{
    order: number;
    question: string;
    answer: string;
    metadata?: Record<string, unknown>;
    indexes: Array<{ type: string; text: string }>;
  }>
> {
  const page = await api<{
    items: Array<{
      order: number;
      question: string;
      answer: string;
      metadata?: Record<string, unknown>;
      indexes: Array<{ type: string; text: string }>;
    }>;
  }>(`/v1/knowledge/sources/${sourceId}/segments?limit=100`, 'GET');
  return page.items;
}

async function bindModels(): Promise<void> {
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
  const space = await api<{ version: number }>(`/v1/knowledge/spaces/${spaceId}`, 'GET');
  await api(`/v1/knowledge/spaces/${spaceId}/model-bindings`, 'PUT', {
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

function xlsxBytes(): Uint8Array {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['q', 'a', 'index', 'metadata'],
      ['表格问题', '表格答案', '表格索引', { source: 'xlsx' }],
    ]),
    'QA',
  );
  return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

async function recordFixture(name: string, bytes: Uint8Array): Promise<string> {
  await writeFile(join(resultDir, name), bytes);
  return createHash('sha256').update(bytes).digest('hex');
}

async function openTemplateImport(page: Awaited<ReturnType<Browser['newPage']>>) {
  await page.goto(
    `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=import&source=template`,
    { waitUntil: 'networkidle' },
  );
  await page.getByRole('button', { name: /模板导入/ }).click();
  await page.getByRole('button', { name: '下一步' }).click();
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_b08_e2e?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-test';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';

  await mkdir(resultDir, { recursive: true });
  const fixtureHashes = {
    templateCsv: await recordFixture(
      'template-edge.csv',
      Buffer.from(
        '\ufeffq,a,index,metadata\r\n' +
          '"重复问题🙌","第一答案,含逗号","索引一","{""source"":""csv""}"\r\n' +
          '"重复问题🙌","第二答案","索引二","{""source"":""csv""}"\r\n',
      ),
    ),
    templateXlsx: await recordFixture('template-single-sheet.xlsx', xlsxBytes()),
    backupCsv: await recordFixture(
      'backup-with-version.csv',
      Buffer.from(
        'q,a,index,metadata,schemaVersion\n' +
          '备份问题,备份答案,备份索引,"{""source"":""backup""}",1\n',
      ),
    ),
  };
  await writeFile(
    join(resultDir, 'fixtures.json'),
    `${JSON.stringify({ runId, suffix, fixtures: fixtureHashes }, null, 2)}\n`,
  );
  app = await startB06aApp({ suffix, workspaceId, memberId, authToken, withWorker: true });
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
  const space = await api<{ id: string }>('/v1/knowledge/spaces', 'POST', {
    kind: 'space',
    parentSpaceId: null,
    name: `B08 ${suffix}`,
    description: 'B08 template and backup validation',
    iconKey: 'book-open',
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
  });
  spaceId = space.id;
  await bindModels();
  connection = await createKnowledgeMongoConnection(process.env.KB_TEST_MONGO_URI);
  registerKnowledgeModels(connection);
  browser = await chromium.launch({ headless: true });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
  if (app) {
    await writeFile(join(resultDir, 'app-and-worker.log'), `${app.output()}\n`);
  }
  await app?.close();
}, 60_000);

describe('TEST-ING-004-BLOCK and TEST-ING-005-BLOCK with the real Worker', () => {
  it.each([
    {
      id: 'L1-B08-ING-004-P01',
      name: 'csv.csv',
      mimeType: 'text/csv',
      bytes: Buffer.from(
        '\ufeffq,a,index,metadata\r\n' +
          '"重复问题🙌","第一答案,含逗号","索引一","{""source"":""csv""}"\r\n' +
          '"重复问题🙌","第二答案","索引二","{""source"":""csv""}"\r\n',
      ),
    },
    {
      id: 'L1-B08-ING-004-P01',
      name: 'template.XLSX',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: xlsxBytes(),
    },
  ])(
    '$id/S01 preserves each template row as a queryable Segment for $name',
    async ({ id, name, mimeType, bytes }) => {
      const uploaded = await uploadFile({ name: `${id}-${suffix}-${name}`, mimeType, bytes });
      expect(uploaded.completeStatus).toBe(200);
      const submitted = await rawApi(`/v1/knowledge/spaces/${spaceId}/imports/template`, 'POST', {
        uploadId: uploaded.uploadId,
        directoryId: null,
      });
      expect(submitted.response.status, JSON.stringify(submitted.payload)).toBe(202);
      const jobId = String((submitted.payload.data as { jobId?: string } | undefined)?.jobId ?? '');
      const job = await waitForJob(jobId);
      expect(job.status, JSON.stringify(job)).toBe('succeeded');
      const imported = (await listSources()).find((source) => source.name.includes(name));
      expect(imported).toBeTruthy();
      const segments = await listSegments(imported!.id);
      expect(segments).toHaveLength(name.endsWith('.csv') ? 2 : 1);
      expect(segments[0]).toMatchObject({
        order: 0,
        question: name.endsWith('.csv') ? '重复问题🙌' : '表格问题',
        answer: name.endsWith('.csv') ? '第一答案,含逗号' : '表格答案',
        metadata: { source: name.endsWith('.csv') ? 'csv' : 'xlsx' },
      });
      expect(segments[0]?.indexes.map((index) => index.text)).toEqual([
        name.endsWith('.csv') ? '索引一' : '表格索引',
      ]);
    },
    150_000,
  );

  it('L1-B08-ING-005-P01/S01 dry-runs then restores q/a/index/metadata through the Worker', async () => {
    const bytes = Buffer.from(
      'q,a,index,metadata,schemaVersion\n' +
        '备份问题,备份答案,备份索引,"{""source"":""backup""}",1\n',
    );
    const uploaded = await uploadFile({
      name: `backup-${suffix}.csv`,
      mimeType: 'text/csv',
      bytes,
    });
    expect(uploaded.completeStatus).toBe(200);
    const dryRun = await rawApi(`/v1/knowledge/spaces/${spaceId}/imports/backup`, 'POST', {
      uploadId: uploaded.uploadId,
      directoryId: null,
      dryRun: true,
      conflictStrategy: 'fail',
    });
    expect(dryRun.response.status).toBe(202);
    const dryRunJobId = String(
      (dryRun.payload.data as { jobId?: string } | undefined)?.jobId ?? '',
    );
    const dryRunJob = await waitForJob(dryRunJobId);
    expect(dryRunJob).toMatchObject({ status: 'succeeded', result: { dryRun: true } });

    const restored = await rawApi(`/v1/knowledge/spaces/${spaceId}/imports/backup`, 'POST', {
      uploadId: uploaded.uploadId,
      directoryId: null,
      dryRun: false,
      conflictStrategy: 'fail',
    });
    expect(restored.response.status, JSON.stringify(restored.payload)).toBe(202);
    const restoreJobId = String(
      (restored.payload.data as { jobId?: string } | undefined)?.jobId ?? '',
    );
    const restoreJob = await waitForJob(restoreJobId);
    expect(restoreJob.status, JSON.stringify(restoreJob)).toBe('succeeded');
    const source = (await listSources()).find((entry) => entry.name === '备份问题');
    expect(source).toBeTruthy();
    expect(await listSegments(source!.id)).toEqual([
      expect.objectContaining({
        question: '备份问题',
        answer: '备份答案',
        metadata: { source: 'backup' },
        indexes: [expect.objectContaining({ text: '备份索引' })],
      }),
    ]);
  }, 150_000);

  it('TEST-X-BACKUP-RESTORE exports a product artifact that the product backup entry can restore', async () => {
    const source = await api<{ id: string }>(`/v1/knowledge/spaces/${spaceId}/sources`, 'POST', {
      kind: 'text',
      directoryId: null,
      name: `roundtrip-${suffix}`,
      searchEnabled: true,
      metadata: {},
    });
    await api(`/v1/knowledge/sources/${source.id}/segments`, 'POST', {
      question: '往返问题',
      answer: '往返答案',
      segmentType: 'qa',
      searchEnabled: true,
      metadata: { source: 'roundtrip' },
    });
    const exported = await api<{ jobId: string }>(
      `/v1/knowledge/spaces/${spaceId}/exports`,
      'POST',
      { format: 'zip', sourceIds: [source.id] },
    );
    const exportJob = await waitForJob(exported.jobId);
    expect(exportJob.status, JSON.stringify(exportJob)).toBe('succeeded');
    const blobId = (exportJob.result as { objectBlobRefId?: string } | undefined)?.objectBlobRefId;
    expect(blobId).toBeTruthy();
    const ticket = await api<{ url: string }>(
      `/v1/knowledge/files/${encodeURIComponent(blobId!)}/download`,
      'POST',
      { disposition: 'attachment' },
    );
    const archiveContext = await browser.newContext({ acceptDownloads: true });
    await archiveContext.addCookies([cookie]);
    const archivePage = await archiveContext.newPage();
    await archivePage.goto(`${app.baseUrl}/dataset/detail?datasetId=${spaceId}`, {
      waitUntil: 'networkidle',
    });
    const downloaded = archivePage.waitForEvent('download');
    await archivePage.evaluate((url) => {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'product-backup.zip';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }, ticket.url);
    const archivePath = join(resultDir, `product-backup-${suffix}.zip`);
    await (await downloaded).saveAs(archivePath);
    const archiveBytes = await readFile(archivePath);
    await archiveContext.close();
    const archived = await uploadFile({
      name: `product-backup-${suffix}.zip`,
      mimeType: 'application/zip',
      bytes: new Uint8Array(archiveBytes),
    });
    expect(archived.completeStatus).toBe(200);
    const restored = await rawApi(`/v1/knowledge/spaces/${spaceId}/imports/backup`, 'POST', {
      uploadId: archived.uploadId,
      directoryId: null,
      dryRun: true,
      conflictStrategy: 'fail',
    });
    expect(restored.response.status).toBe(202);
  }, 180_000);

  it('L1-B08-ING-004-UI01 exposes template download, structured preview and accessibility', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await openTemplateImport(page);
    await page.screenshot({
      path: join(resultDir, 'template-import-entry-1440.png'),
      fullPage: true,
    });
    await playwrightExpect(page.getByText('下载 CSV 模板', { exact: true })).toBeVisible();
    await page.locator('input[type=file]').setInputFiles({
      name: `ui-template-${suffix}.csv`,
      mimeType: 'text/csv',
      buffer: Buffer.from('q,a,index,metadata\nUI 问题,UI 答案,UI 索引,"{}"\n'),
    });
    await playwrightExpect(page.getByText(/completed|上传完成/).first()).toBeVisible();
    await page.getByRole('button', { name: '下一步' }).click();
    await playwrightExpect(page.getByText(/UI 问题/).first()).toBeVisible();
    await playwrightExpect(page.getByText(/UI 答案/).first()).toBeVisible();
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await page.screenshot({ path: join(resultDir, 'template-ui-1440.png'), fullPage: true });
    await context.close();
  }, 90_000);

  it('L1-B08-ING-005-UI01 requires a visible dry-run plan before restore confirmation', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(
      `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=import&source=backup`,
      { waitUntil: 'networkidle' },
    );
    await page.getByRole('button', { name: /备份导入/ }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.locator('input[type=file]').setInputFiles({
      name: `ui-backup-${suffix}.csv`,
      mimeType: 'text/csv',
      buffer: Buffer.from(
        'q,a,index,metadata,schemaVersion\nUI 备份问题,UI 备份答案,UI 备份索引,"{}",1\n',
      ),
    });
    await playwrightExpect(page.getByText(/completed|上传完成/).first()).toBeVisible();
    await page.getByLabel('仅检查，不写入数据').check();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    const submitted = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/spaces/${spaceId}/imports/backup`),
    );
    await page.getByRole('button', { name: '确认导入' }).click();
    expect((await submitted).status()).toBe(202);
    await playwrightExpect(page.getByText('已完成', { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({
      path: join(resultDir, 'backup-dry-run-result-1440.png'),
      fullPage: true,
    });
    await playwrightExpect(page.getByText(/新增 0|恢复预览|冲突报告/).first()).toBeVisible();
    await playwrightExpect(page.getByRole('button', { name: /确认恢复|执行恢复/ })).toBeVisible();
    await page.screenshot({ path: join(resultDir, 'backup-dry-run-1440.png'), fullPage: true });
    await context.close();
  }, 90_000);
});
