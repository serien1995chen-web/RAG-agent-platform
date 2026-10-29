import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileFingerprint } from '../../packages/web/src/client/file-upload';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';

const root = resolve(import.meta.dirname, '../..');
const appRoot = join(root, 'projects', 'app');
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_file_e2e_${suffix}`;
const memberId = `mem_file_e2e_${suffix}`;
const authToken = `file-e2e-token-${suffix}`;
const modelNames = [
  'KnowledgeSpace',
  'KnowledgeDirectory',
  'KnowledgeSource',
  'KnowledgeObjectRef',
  'KnowledgeJob',
  'KnowledgeJobStep',
  'KnowledgeAuditEvent',
] as const;

let processHandle: ChildProcess | undefined;
let baseUrl = '';
let spaceId = '';
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>> | undefined;
let output = '';
const fixturePaths = new Set<string>();

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required e2e environment: ${name}`);
  return value;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no test port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (processHandle?.exitCode !== null) {
      throw new Error(`file e2e app exited early\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // Retry while Next.js starts.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`file e2e app did not become healthy\n${output}`);
}

function apiHeaders(idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${authToken}`,
    'x-workspace-id': workspaceId,
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  };
}

function successBody(data: unknown, requestId = `req-${suffix}`) {
  return {
    success: true,
    data,
    traceId: `trace-${suffix}`,
    requestId,
  };
}

function problemBody(
  code: string,
  status: number,
  options: { retryable?: boolean; traceId?: string; requestId?: string } = {},
) {
  return {
    response: {
      status,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        error: {
          code,
          message: code,
          retryable: options.retryable ?? true,
          details: {},
        },
        traceId: options.traceId ?? `trace-${suffix}`,
        requestId: options.requestId ?? `request-${suffix}`,
      }),
    },
    payload: {
      success: false,
      error: {
        code,
        message: code,
        retryable: options.retryable ?? true,
        details: {},
      },
      traceId: options.traceId ?? `trace-${suffix}`,
      requestId: options.requestId ?? `request-${suffix}`,
    },
  };
}

async function consoleCookie(): Promise<{
  name: string;
  value: string;
  domain: string;
  path: string;
  sameSite: 'Strict';
}> {
  const response = await fetch(`${baseUrl}/api/console/session`, {
    method: 'POST',
    headers: {
      ...apiHeaders(),
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const rawCookie = response.headers.get('set-cookie') ?? '';
  const pair = rawCookie.split(';', 1)[0] ?? '';
  const separator = pair.indexOf('=');
  return {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    domain: '127.0.0.1',
    path: '/',
    sameSite: 'Strict',
  };
}

async function authenticatedPage(
  browser: Browser,
  path: string,
  viewport = { width: 1200, height: 900 },
): Promise<{ context: Awaited<ReturnType<Browser['newContext']>>; page: Page }> {
  const context = await browser.newContext({ viewport });
  await context.addCookies([await consoleCookie()]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' });
  return { context, page };
}

async function fileFixture(name: string, bytes: Buffer): Promise<string> {
  const directory = join(root, 'test-results', suffix);
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, bytes);
  const timestamp = 1_700_000_000;
  await utimes(path, timestamp, timestamp);
  fixturePaths.add(path);
  return path;
}

async function createFileSource(
  name: string,
  text: string,
): Promise<{ id: string; blobId: string }> {
  if (!connection) throw new Error('e2e mongo connection missing');
  const body = Buffer.from(text);
  const initResponse = await fetch(`${baseUrl}/v1/knowledge/uploads`, {
    method: 'POST',
    headers: {
      ...apiHeaders(`source-init-${name}-${suffix}`),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      knowledgeSpaceId: spaceId,
      name,
      mimeType: 'text/plain',
      sizeBytes: body.byteLength,
    }),
  });
  const init = (await initResponse.json()) as {
    data: { uploadId: string; partCount: number; partSizeBytes: number };
  };
  const parts: Array<{ partNumber: number; etag: string }> = [];
  if (init.data.partCount === 1) {
    const presignResponse = await fetch(
      `${baseUrl}/v1/knowledge/uploads/${init.data.uploadId}/presign`,
      {
        method: 'POST',
        headers: {
          ...apiHeaders(`source-presign-${name}-${suffix}`),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ partNumbers: [1] }),
      },
    );
    const presign = (await presignResponse.json()) as {
      data: { uploads: Array<{ url: string; headers: Record<string, string> }> };
    };
    const upload = await fetch(presign.data.uploads[0]!.url, {
      method: 'PUT',
      headers: presign.data.uploads[0]!.headers,
      body,
    });
    expect(upload.status).toBe(200);
  } else {
    for (let partNumber = 1; partNumber <= init.data.partCount; partNumber += 1) {
      const start = (partNumber - 1) * init.data.partSizeBytes;
      const part = await fetch(
        `${baseUrl}/v1/knowledge/uploads/${init.data.uploadId}/parts/${partNumber}`,
        {
          method: 'PUT',
          headers: {
            ...apiHeaders(`source-part-${name}-${partNumber}-${suffix}`),
            'content-type': 'application/octet-stream',
          },
          body: body.subarray(start, Math.min(start + init.data.partSizeBytes, body.byteLength)),
        },
      );
      const payload = (await part.json()) as { data: { etag: string } };
      parts.push({ partNumber, etag: payload.data.etag });
    }
  }
  const completeResponse = await fetch(
    `${baseUrl}/v1/knowledge/uploads/${init.data.uploadId}/complete`,
    {
      method: 'POST',
      headers: {
        ...apiHeaders(`source-complete-${name}-${suffix}`),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ parts }),
    },
  );
  const completed = (await completeResponse.json()) as { data: { blobId: string } };
  const source = await connection.models.KnowledgeSource.create({
    workspaceId,
    knowledgeSpaceId: new connection.base.Types.ObjectId(spaceId),
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    kind: 'file',
    name,
    blobRefId: new connection.base.Types.ObjectId(completed.data.blobId),
    mimeType: 'text/plain',
    sizeBytes: body.byteLength,
    ownershipMemberId: memberId,
  });
  await connection.models.KnowledgeObjectRef.updateOne(
    {
      workspaceId,
      _id: new connection.base.Types.ObjectId(completed.data.blobId),
    },
    { $set: { sourceId: source._id } },
  );
  return { id: String(source._id), blobId: completed.data.blobId };
}

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const nextBinary = join(appRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBinary)) throw new Error(`Next binary not found: ${nextBinary}`);
  processHandle = spawn(process.execPath, [nextBinary, 'start', '-p', String(port)], {
    cwd: appRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      KB_ENV: 'test',
      KB_APP_WORKER_MODE: 'http',
      KB_PORT: String(port),
      KB_INSTANCE_ID: `file-e2e-${suffix}`,
      KB_MONGO_URI: requiredEnv('KB_TEST_MONGO_URI'),
      KB_REDIS_URL: requiredEnv('KB_TEST_REDIS_URL'),
      KB_PG_URL: requiredEnv('KB_TEST_PG_URL'),
      KB_S3_ENDPOINT: requiredEnv('KB_TEST_S3_ENDPOINT'),
      KB_S3_REGION: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
      KB_S3_BUCKET: requiredEnv('KB_TEST_S3_BUCKET'),
      KB_S3_ACCESS_KEY_REF: 'env:KB_FILE_E2E_S3_ACCESS',
      KB_S3_SECRET_KEY_REF: 'env:KB_FILE_E2E_S3_SECRET',
      KB_FILE_E2E_S3_ACCESS: requiredEnv('KB_TEST_S3_ACCESS_KEY'),
      KB_FILE_E2E_S3_SECRET: requiredEnv('KB_TEST_S3_SECRET_KEY'),
      KB_FILE_PUBLIC_BASE_URL: baseUrl,
      KB_FILE_TICKET_SECRET_REF: 'env:KB_FILE_E2E_TICKET_SECRET',
      KB_FILE_E2E_TICKET_SECRET: `file-e2e-ticket-secret-${suffix}-value`,
      KB_CREDENTIAL_ENCRYPTION_KEY_REF: 'env:KB_FILE_E2E_CREDENTIAL_KEY',
      KB_FILE_E2E_CREDENTIAL_KEY: `file-e2e-credential-key-${suffix}-value`,
      KB_CITATION_SIGNING_SECRET_REF: 'env:KB_FILE_E2E_CITATION_SECRET',
      KB_FILE_E2E_CITATION_SECRET: `file-e2e-citation-${suffix}-fixed-secret-value`,
      KB_AUTH_MODE: 'mock',
      KB_MOCK_AUTH_TOKEN: authToken,
      API_KEY_HMAC_SECRET_FILE: `${process.cwd()}/test/fixtures/s10/api-key-hmac.secret`,
      KB_MOCK_WORKSPACE_ID: workspaceId,
      KB_MOCK_MEMBER_ID: memberId,
      KB_MOCK_SCOPES: 'knowledge:read,knowledge:write,knowledge:manage,knowledge:admin',
      KB_MOCK_WORKSPACE_OWNER: 'true',
      KB_EXTERNAL_MODEL_MODE: 'mock',
      KB_EXTERNAL_OCR_MODE: 'mock',
      KB_EXTERNAL_CONNECTOR_MODE: 'mock',
      KB_LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processHandle.stdout?.on('data', (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-20_000);
  });
  processHandle.stderr?.on('data', (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-20_000);
  });
  await waitForHealth();
  const response = await fetch(`${baseUrl}/v1/knowledge/spaces`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${authToken}`,
      'x-workspace-id': workspaceId,
      'content-type': 'application/json',
      'idempotency-key': `space-${suffix}`,
    },
    body: JSON.stringify({
      kind: 'space',
      name: `File E2E ${suffix}`,
      accessMode: 'workspace',
      sourceAclMode: 'inherited',
      sourcePermissionEnabled: true,
    }),
  });
  const payload = (await response.json()) as { success: boolean; data: { id: string } };
  expect(payload.success).toBe(true);
  spaceId = payload.data.id;
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  registerKnowledgeModels(connection);
}, 120_000);

afterAll(async () => {
  if (processHandle && processHandle.exitCode === null) {
    processHandle.kill('SIGTERM');
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  if (connection) {
    const models = registerKnowledgeModels(connection);
    for (const name of modelNames) {
      const model = models[name];
      if (model) await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
  for (const path of fixturePaths) {
    await rm(path, { force: true });
  }
}, 30_000);

describe('ACC-UI-01…07 file surfaces', () => {
  it('ACC-UI-01 uploads a single file and does not expose fake readiness', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const { context, page } = await authenticatedPage(browser, `/spaces/${spaceId}/import`);
      await page.setInputFiles('input[type=file]', {
        name: 'single-upload.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('single upload e2e'),
      });
      await page.getByRole('button', { name: '上传', exact: true }).click();
      await page.getByText('上传完成', { exact: true }).waitFor({ timeout: 120_000 });
      expect(await page.getByText(/READY|导入已成功|解析已成功/, { exact: false }).count()).toBe(0);
      await page.reload({ waitUntil: 'networkidle' });
      expect(await page.getByText(/READY|导入已成功|解析已成功/, { exact: false }).count()).toBe(0);
      await context.close();
    } finally {
      await browser.close();
    }
  }, 120_000);

  it('ACC-UI-07 renders Import and Sources at 360/768/1200 without overflow or blocking axe defects', async () => {
    const session = await fetch(`${baseUrl}/api/console/session`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authToken}`,
        'x-workspace-id': workspaceId,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    const rawCookie = session.headers.get('set-cookie') ?? '';
    const pair = rawCookie.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const browser = await chromium.launch({ headless: true });
    try {
      for (const viewport of [
        { width: 360, height: 800 },
        { width: 768, height: 1024 },
        { width: 1200, height: 900 },
      ]) {
        const context = await browser.newContext({ viewport });
        await context.addCookies([
          { name, value, domain: '127.0.0.1', path: '/', sameSite: 'Strict' },
        ]);
        const page = await context.newPage();
        const consoleErrors: string[] = [];
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text());
        });
        await page.goto(`${baseUrl}/spaces/${spaceId}/import`, {
          waitUntil: 'networkidle',
        });
        await page.getByRole('heading', { level: 1, name: '导入知识来源' }).waitFor();
        expect(await page.locator('input[type=file]').count()).toBe(1);
        expect(await page.getByRole('button', { name: '选择文件' }).count()).toBe(1);
        expect(await page.getByText('选择文件', { exact: true }).count()).toBeGreaterThan(0);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        );
        expect(overflow, `${viewport.width}px horizontal overflow`).toBe(false);
        const accessibility = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(
          accessibility.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          ),
        ).toEqual([]);
        expect(consoleErrors).toEqual([]);
        await page.screenshot({
          path: `test-results/knowledge-file-import-${viewport.width}.png`,
          fullPage: true,
        });
        await page.goto(`${baseUrl}/spaces/${spaceId}/sources`, {
          waitUntil: 'networkidle',
        });
        await page.getByRole('heading', { level: 1, name: '来源' }).waitFor();
        const sourcesOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        );
        expect(sourcesOverflow, `${viewport.width}px Sources horizontal overflow`).toBe(false);
        const sourcesAccessibility = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(
          sourcesAccessibility.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          ),
        ).toEqual([]);
        expect(consoleErrors).toEqual([]);
        await page.screenshot({
          path: `test-results/knowledge-file-sources-${viewport.width}.png`,
          fullPage: true,
        });
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it('ACC-UI-03 previews Source text and restores focus when the dialog closes', async () => {
    const name = `preview-focus-${suffix}.txt`;
    const text = `preview text ${suffix}`;
    await createFileSource(name, text);
    const browser = await chromium.launch({ headless: true });
    try {
      const { context, page } = await authenticatedPage(browser, `/spaces/${spaceId}/sources`);
      const row = page.getByRole('row').filter({ hasText: name });
      const trigger = row.getByRole('button', { name: '预览' });
      await trigger.click();
      const dialog = page.getByRole('dialog');
      await dialog.getByText(text).waitFor();
      await dialog.getByRole('button', { name: '关闭' }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.waitForTimeout(250);
      expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true);
      await context.close();
    } finally {
      await browser.close();
    }
  });

  it('ACC-UI-04 exposes a reliable Source download link and localizes expired tickets', async () => {
    const name = `download-${suffix}.txt`;
    await createFileSource(name, 'downloadable source');
    const browser = await chromium.launch({ headless: true });
    try {
      const first = await authenticatedPage(browser, `/spaces/${spaceId}/sources`);
      const row = first.page.getByRole('row').filter({ hasText: name });
      await row.getByRole('button', { name: '下载' }).click();
      const link = row.getByRole('link', { name: '下载' });
      await link.waitFor();
      expect(await link.getAttribute('href')).toContain('/v1/knowledge/files/');
      await first.context.close();

      const second = await authenticatedPage(browser, `/spaces/${spaceId}/sources`);
      const problem = problemBody('KNOWLEDGE_FORBIDDEN', 403, {
        retryable: false,
        traceId: 'trace-expired-ticket',
        requestId: 'request-expired-ticket',
      });
      await second.page.route('**/v1/knowledge/sources/*/download', (route) =>
        route.fulfill(problem.response),
      );
      const deniedRow = second.page.getByRole('row').filter({ hasText: name });
      await deniedRow.getByRole('button', { name: '下载' }).click();
      await deniedRow.getByText('当前工作区无权访问该资源。').waitFor();
      await deniedRow.getByText('追踪 trace-expired-ticket').waitFor();
      await second.context.close();
    } finally {
      await browser.close();
    }
  });

  it('ACC-UI-05 archives selected Sources and exposes queued/running/succeeded/failed states', async () => {
    const firstName = `archive-a-${suffix}.txt`;
    const secondName = `archive-b-${suffix}.txt`;
    await createFileSource(firstName, 'archive a');
    await createFileSource(secondName, 'archive b');
    const browser = await chromium.launch({ headless: true });
    try {
      const { context, page } = await authenticatedPage(browser, `/spaces/${spaceId}/sources`);
      let mode: 'success' | 'failed' = 'success';
      let pollCount = 0;
      await page.route(`**/v1/knowledge/spaces/${spaceId}/source-archives`, (route) =>
        route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify(
            successBody({ jobId: 'ui-archive-job', status: 'queued', result: null }),
          ),
        }),
      );
      await page.route('**/v1/knowledge/jobs/ui-archive-job', async (route) => {
        pollCount += 1;
        if (mode === 'failed') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(
              successBody({ jobId: 'ui-archive-job', status: 'failed', result: null }),
            ),
          });
          return;
        }
        const status = pollCount === 1 ? 'running' : 'succeeded';
        await new Promise((resolveWait) => setTimeout(resolveWait, 350));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            successBody({
              jobId: 'ui-archive-job',
              status,
              result:
                status === 'succeeded'
                  ? {
                      objectBlobRefId: '65f1e5b2a1c9d4b7e8f09abc',
                      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                    }
                  : null,
            }),
          ),
        });
      });
      await page.route('**/v1/knowledge/files/*/download', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            successBody({ ticketId: 'archive-ticket', url: `${baseUrl}/downloads/archive.zip` }),
          ),
        }),
      );
      await page.getByRole('checkbox', { name: new RegExp(firstName) }).check();
      await page.getByRole('checkbox', { name: new RegExp(secondName) }).check();
      await page.getByRole('button', { name: '打包下载' }).click();
      await page.getByText('打包任务已排队', { exact: true }).waitFor();
      await page.getByText('正在生成压缩包', { exact: true }).waitFor();
      await page.getByText('压缩包已就绪', { exact: true }).waitFor();
      const archiveLink = page.getByRole('link', { name: '下载压缩包' });
      await archiveLink.waitFor();
      expect(await archiveLink.getAttribute('href')).toBe(`${baseUrl}/downloads/archive.zip`);

      mode = 'failed';
      pollCount = 0;
      await page.getByRole('button', { name: '打包下载' }).click();
      await page.getByText('打包任务失败', { exact: true }).waitFor();
      await context.close();
    } finally {
      await browser.close();
    }
  });

  it('ACC-UI-06 renders 413/422/409/403 and network errors with traceId and retry', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const { context, page } = await authenticatedPage(browser, `/spaces/${spaceId}/import`);
      let currentCode = 'KNOWLEDGE_PAYLOAD_TOO_LARGE';
      let currentStatus = 413;
      let requestCount = 0;
      await page.route('**/v1/knowledge/uploads', async (route) => {
        requestCount += 1;
        const problem = problemBody(currentCode, currentStatus, {
          retryable: currentStatus === 409,
          traceId: 'trace-ui-errors',
          requestId: 'request-ui-errors',
        });
        await route.fulfill(problem.response);
      });
      for (const [code, status] of [
        ['KNOWLEDGE_PAYLOAD_TOO_LARGE', 413],
        ['KNOWLEDGE_UNSUPPORTED_CONTENT', 422],
        ['KNOWLEDGE_CONFLICT', 409],
        ['KNOWLEDGE_FORBIDDEN', 403],
      ] as const) {
        currentCode = code;
        currentStatus = status;
        await page.setInputFiles('input[type=file]', {
          name: `error-${status}.txt`,
          mimeType: 'text/plain',
          buffer: Buffer.from(`error ${status}`),
        });
        await page.getByRole('button', { name: '上传', exact: true }).click();
        await page.getByText(code, { exact: true }).waitFor();
        await page.getByText('追踪 trace-ui-errors').waitFor();
        if (status === 409) {
          const beforeRetry = requestCount;
          await page.getByRole('button', { name: '重试' }).click();
          await page.getByText(code, { exact: true }).waitFor();
          await expect.poll(() => requestCount).toBeGreaterThan(beforeRetry);
        }
      }
      await page.unroute('**/v1/knowledge/uploads');
      await page.route('**/v1/knowledge/uploads', (route) => route.abort('failed'));
      await page.setInputFiles('input[type=file]', {
        name: 'network-error.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('network error'),
      });
      await page.getByRole('button', { name: '上传', exact: true }).click();
      await page.getByText('请求失败', { exact: true }).waitFor();
      await context.close();
    } finally {
      await browser.close();
    }
  });

  it('ACC-UI-02 / TEST-FILE-001-U22 resumes a three-part upload after refresh', async () => {
    const sessionResponse = await fetch(`${baseUrl}/api/console/session`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authToken}`,
        'x-workspace-id': workspaceId,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    const rawCookie = sessionResponse.headers.get('set-cookie') ?? '';
    const pair = rawCookie.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    const cookie = {
      name: pair.slice(0, separator),
      value: pair.slice(separator + 1),
      domain: '127.0.0.1',
      path: '/',
      sameSite: 'Strict' as const,
    };
    const size = 2 * 8 * 1024 * 1024 + 1024;
    const bytes = Buffer.alloc(size, 'a');
    const fixturePath = await fileFixture('large.txt', bytes);
    const fingerprint = await fileFingerprint(
      new File([bytes], 'large.txt', {
        type: 'text/plain',
        lastModified: Math.trunc((await stat(fixturePath)).mtimeMs),
      }),
    );
    expect(fingerprint).not.toBeNull();
    const initResponse = await fetch(`${baseUrl}/v1/knowledge/uploads`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authToken}`,
        'x-workspace-id': workspaceId,
        'content-type': 'application/json',
        'idempotency-key': `large-init-${suffix}`,
      },
      body: JSON.stringify({
        knowledgeSpaceId: spaceId,
        name: 'large.txt',
        mimeType: 'text/plain',
        sizeBytes: size,
      }),
    });
    const initPayload = (await initResponse.json()) as {
      data: { uploadId: string; partSizeBytes: number };
    };
    const uploadId = initPayload.data.uploadId;
    const firstPart = await fetch(`${baseUrl}/v1/knowledge/uploads/${uploadId}/parts/1`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${authToken}`,
        'x-workspace-id': workspaceId,
        'content-type': 'application/octet-stream',
        'idempotency-key': `large-part-1-${suffix}`,
      },
      body: bytes.subarray(0, initPayload.data.partSizeBytes),
    });
    expect(firstPart.status).toBe(200);
    const firstPartPayload = (await firstPart.json()) as { data: { etag: string } };

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await context.addCookies([cookie]);
      const page = await context.newPage();
      await page.goto(`${baseUrl}/spaces/${spaceId}/import`, { waitUntil: 'networkidle' });
      await page.evaluate(
        ({ storageKey, id, etag, fingerprint: value }) => {
          window.localStorage.setItem(
            storageKey,
            JSON.stringify({
              uploadId: id,
              phase: 'uploading',
              progress: 33,
              parts: [{ partNumber: 1, etag: etag }],
              fingerprint: value,
            }),
          );
        },
        {
          storageKey: `kb-upload:${workspaceId}:large.txt:${size}:${fingerprint}`,
          id: uploadId,
          etag: firstPartPayload.data.etag,
          fingerprint,
        },
      );
      await page.reload({ waitUntil: 'networkidle' });
      await page.setInputFiles('input[type=file]', fixturePath);
      await page.getByRole('button', { name: '上传', exact: true }).click();
      await page.getByText('上传完成', { exact: true }).waitFor({ timeout: 120_000 });
      const job = await fetch(`${baseUrl}/v1/knowledge/uploads/${uploadId}`, {
        headers: {
          authorization: `Bearer ${authToken}`,
          'x-workspace-id': workspaceId,
        },
      });
      const body = (await job.json()) as { data: { status: string } };
      expect(body.data.status).toBe('completed');
      await context.close();
    } finally {
      await browser.close();
    }
  }, 120_000);
});
