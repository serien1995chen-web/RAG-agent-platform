import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
      KB_AUTH_MODE: 'mock',
      KB_MOCK_AUTH_TOKEN: authToken,
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
}, 30_000);

describe('ACC-UI-01…07 file surfaces', () => {
  it('renders the upload shell at 360/768/1200 without overflow or blocking axe defects', async () => {
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
        await page.getByRole('heading', { level: 1, name: '文件上传' }).waitFor();
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
          path: `test-results/knowledge-file-${viewport.width}.png`,
          fullPage: true,
        });
        await context.close();
      }
    } finally {
      await browser.close();
    }
  });

  it('TEST-FILE-001-U22 resumes a three-part upload after refresh', async () => {
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
        ({ storageKey, id, etag }) => {
          window.localStorage.setItem(
            storageKey,
            JSON.stringify({
              uploadId: id,
              phase: 'uploading',
              progress: 33,
              parts: [{ partNumber: 1, etag: etag }],
            }),
          );
        },
        {
          storageKey: `kb-upload:${workspaceId}:large.txt:${size}`,
          id: uploadId,
          etag: firstPartPayload.data.etag,
        },
      );
      await page.reload({ waitUntil: 'networkidle' });
      await page.setInputFiles('input[type=file]', {
        name: 'large.txt',
        mimeType: 'text/plain',
        buffer: bytes,
      });
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
