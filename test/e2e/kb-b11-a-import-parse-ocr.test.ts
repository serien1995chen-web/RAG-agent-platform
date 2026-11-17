import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startB06aApp, type B06aAppHarness } from './b06a-harness';
import { apiHeaders, consoleCookie } from './s4-app-harness';
import { b11PdfWithText } from '../fixtures/b11/generate-fixtures';

const root = resolve(import.meta.dirname, '../..');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_b11_e2e_${suffix}`;
const memberId = `mem_b11_e2e_${suffix}`;
const authToken = `b11-e2e-${suffix}`;
const resultDir = join(root, 'test-results', 'b11', 'a', `e2e-${suffix}`);

let app: B06aAppHarness;
let browser: Browser;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let spaceId = '';

interface JobView {
  jobId: string;
  kind: string;
  status: string;
  result?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
  progress?: Record<string, unknown>;
  steps?: Array<{ stepKey: string; status: string; externalEvidence?: Record<string, unknown> }>;
}

function headers() {
  return apiHeaders({
    authToken,
    workspaceId,
    idempotencyKey: `b11-e2e-${randomUUID()}`,
  });
}

async function api<T = Record<string, unknown>>(
  path: string,
  method: 'GET' | 'POST' | 'PUT' = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...headers(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: { code?: string; details?: unknown };
  };
  if (!response.ok || payload.success !== true) {
    throw new Error(
      `${method} ${path} -> ${response.status} ${JSON.stringify(payload.error ?? payload)}`,
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
  }>('/v1/knowledge/models?limit=200');
  const selected = catalog.items
    .filter((model) => model.authorized && ['llm', 'embedding', 'rerank'].includes(model.type))
    .filter(
      (model, index, rows) =>
        rows.findIndex((candidate) => candidate.type === model.type) === index,
    );
  const space = await api<{ version: number }>(`/v1/knowledge/spaces/${spaceId}`);
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

async function uploadPdf(name: string, body: Buffer): Promise<string> {
  const session = await api<{ uploadId: string }>('/v1/knowledge/uploads', 'POST', {
    knowledgeSpaceId: spaceId,
    name,
    mimeType: 'application/pdf',
    sizeBytes: body.byteLength,
  });
  const presigned = await api<{
    uploads: Array<{ url: string; headers: Record<string, string> }>;
  }>(`/v1/knowledge/uploads/${session.uploadId}/presign`, 'POST', { partNumbers: [1] });
  const upload = await fetch(presigned.uploads[0]!.url, {
    method: 'PUT',
    headers: presigned.uploads[0]!.headers,
    body,
  });
  expect(upload.status).toBe(200);
  const complete = await fetch(`${app.baseUrl}/v1/knowledge/uploads/${session.uploadId}/complete`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [] }),
  });
  expect(complete.status).toBe(200);
  return session.uploadId;
}

async function waitForJob(jobId: string, timeoutMs = 60_000): Promise<JobView> {
  const deadline = Date.now() + timeoutMs;
  let latest: JobView | undefined;
  while (Date.now() < deadline) {
    latest = await api<JobView>(`/v1/knowledge/jobs/${jobId}`);
    if (['succeeded', 'failed', 'dead_letter', 'cancelled'].includes(latest.status)) {
      return latest;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  }
  throw new Error(`B11 job timeout: ${JSON.stringify(latest)}`);
}

async function importPdf(input: {
  name: string;
  parseProvider: 'liteparse' | 'somark';
  parseConfig: Record<string, unknown>;
}) {
  const bytes = b11PdfWithText();
  const uploadId = await uploadPdf(input.name, bytes);
  const job = await api<{ jobId: string }>(
    `/v1/knowledge/spaces/${spaceId}/imports/files`,
    'POST',
    {
      uploadIds: [uploadId],
      parseProvider: input.parseProvider,
      parseConfig: input.parseConfig,
      chunking: {
        trainingType: 'chunk',
        chunkSettingMode: 'custom',
        chunkSplitMode: 'size',
        chunkSize: 128,
      },
    },
  );
  const settled = await waitForJob(job.jobId);
  return { bytes, job: settled };
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_b11_e2e?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-test';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';

  app = await startB06aApp({
    suffix,
    workspaceId,
    memberId,
    authToken,
    withWorker: true,
  });
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
  const space = await api<{ id: string }>('/v1/knowledge/spaces', 'POST', {
    kind: 'space',
    parentSpaceId: null,
    name: `B11 Parse OCR ${suffix}`,
    description: 'B11 document parse and OCR validation',
    iconKey: 'book-open',
    accessMode: 'workspace',
    sourceAclMode: 'enforced',
    sourcePermissionEnabled: true,
  });
  spaceId = space.id;
  await bindModels();
  browser = await chromium.launch({ headless: true });
  await mkdir(resultDir, { recursive: true });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
}, 60_000);

describe('L1-B11-A real import, parse, preview and segment chain', () => {
  it('L1-B11-A-PARSE-001-P03 keeps rawText preview and Segment content on one Source version', async () => {
    const { bytes, job } = await importPdf({
      name: `b11-liteparse-${suffix}.pdf`,
      parseProvider: 'liteparse',
      parseConfig: {},
    });
    expect(job.status).toBe('succeeded');
    const childIds = Array.isArray(job.result?.childJobIds)
      ? job.result.childJobIds.map(String)
      : [];
    expect(childIds.length).toBeGreaterThan(0);
    const children = await Promise.all(
      childIds.map((childId) => api<JobView>(`/v1/knowledge/jobs/${childId}`)),
    );
    const parse = children.find((child) => child.kind === 'parse');
    expect(parse).toBeDefined();
    const sources = await api<{
      items: Array<{ id: string; name: string; sourceVersion: number; contentHash: string }>;
    }>(`/v1/knowledge/spaces/${spaceId}/sources?limit=100`);
    const source = sources.items.find((item) => item.name === `b11-liteparse-${suffix}.pdf`);
    expect(source).toBeDefined();
    const preview = await api<{
      sourceId: string;
      sections: Array<{ order: number; text: string }>;
    }>(`/v1/knowledge/sources/${source!.id}/preview`);
    const rawText = preview.sections.map((section) => section.text).join('\n\n');
    expect(rawText).toContain('B11 text layer document');
    expect(createHash('sha256').update(rawText).digest('hex')).toBe(source!.contentHash);
    const segments = await api<{
      items: Array<{ content: string; sourceVersion: number }>;
      pageInfo: { nextCursor: string | null; hasMore: boolean };
    }>(`/v1/knowledge/sources/${source!.id}/segments?limit=100`);
    expect(segments.items.length).toBeGreaterThan(0);
    expect(segments.items.every((segment) => segment.sourceVersion === source!.sourceVersion));
    expect(segments.items.map((segment) => segment.content).join('')).toContain(
      'B11 text layer document',
    );
    expect(parse?.result?.contentHash).toBeTruthy();
    expect(JSON.stringify({ job, parse, preview, source, segments })).not.toMatch(
      /"(bucket|objectKey|authorization|api[-_]?key|secret)":/i,
    );
    expect(bytes.byteLength).toBeGreaterThan(0);
  }, 300_000);

  it('L1-B11-A-PARSE-001-S03 leaves every completed Job step terminal', async () => {
    const { job } = await importPdf({
      name: `b11-steps-${suffix}.pdf`,
      parseProvider: 'liteparse',
      parseConfig: {},
    });
    const childIds = Array.isArray(job.result?.childJobIds)
      ? job.result.childJobIds.map(String)
      : [];
    const detail = await api<JobView>(`/v1/knowledge/jobs/${job.jobId}`);
    const parseChildId = childIds[0];
    const parse = parseChildId ? await api<JobView>(`/v1/knowledge/jobs/${parseChildId}`) : null;
    const steps = [...(detail.steps ?? []), ...(parse?.steps ?? [])];
    expect(steps.length).toBeGreaterThan(0);
    expect(
      steps.filter((step) => ['pending', 'running', 'retry_wait'].includes(step.status)),
    ).toEqual([]);
  }, 300_000);

  it('L1-B11-A-PARSE-002-S03 records the selected external Provider and usage in the real import path', async () => {
    const { job } = await importPdf({
      name: `b11-somark-${suffix}.pdf`,
      parseProvider: 'somark',
      parseConfig: {
        provider: 'somark',
        credentialProfileId: 'env:S11_OCR_SOMARK_PROFILE_JSON',
        fallbackProvider: 'none',
        imageHandling: 'drop',
        timeoutMs: 120_000,
      },
    });
    const childIds = Array.isArray(job.result?.childJobIds)
      ? job.result.childJobIds.map(String)
      : [];
    const children = await Promise.all(
      childIds.map((childId) => api<JobView>(`/v1/knowledge/jobs/${childId}`)),
    );
    const parse = children.find((child) => child.kind === 'parse');
    expect(parse?.status).toBe('succeeded');
    expect(String(parse?.result?.parserVersion ?? '')).toMatch(/somark/i);
    expect(parse?.steps).toContainEqual(
      expect.objectContaining({
        stepKey: 'persist-segments',
        externalEvidence: expect.objectContaining({ fallbackUsed: false }),
      }),
    );
    expect(JSON.stringify(parse)).not.toContain('B11-SUPER-SECRET');
  }, 300_000);
});

describe('L1-B11-A import settings UI', () => {
  it('L1-B11-A-PARSE-002-UI04 exposes recoverable Provider, credential, fallback, image and timeout controls at three viewports', async () => {
    for (const viewport of [
      { width: 360, height: 800 },
      { width: 768, height: 1024 },
      { width: 1200, height: 900 },
    ]) {
      const context = await browser.newContext({ viewport, locale: 'zh-CN' });
      await context.addCookies([cookie]);
      const page = await context.newPage();
      await page.goto(
        `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=import&source=fileCustom`,
        { waitUntil: 'networkidle' },
      );
      await page.getByRole('button', { name: /本地文件/ }).click();
      await page.getByRole('button', { name: '下一步' }).click();
      await playwrightExpect(page.getByText('解析器', { exact: true })).toBeVisible();
      await page.getByLabel('解析器').selectOption('somark');
      for (const label of ['凭据配置', '回退', '图片处理', '超时']) {
        await playwrightExpect(page.getByText(label, { exact: true })).toBeVisible();
      }
      await page.getByLabel('凭据配置').fill('env:S11_OCR_SOMARK_PROFILE_JSON');
      await page.getByLabel('回退').selectOption('none');
      await page.getByLabel('图片处理').selectOption('drop');
      await page.screenshot({
        path: join(resultDir, `parse-ocr-settings-${viewport.width}.png`),
        fullPage: true,
      });
      const axe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        axe.violations.filter(
          (violation) => violation.impact === 'serious' || violation.impact === 'critical',
        ),
      ).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
      ).toBe(false);
      await context.close();
    }
  }, 180_000);
});
