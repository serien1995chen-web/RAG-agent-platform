import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';

const root = resolve(import.meta.dirname, '../..');
const appRoot = join(root, 'projects', 'app');
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s5_e2e_${suffix}`;
const memberId = `mem_s5_e2e_${suffix}`;
const authToken = `s5-e2e-token-${suffix}`;

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
      throw new Error(`S5 e2e app exited early\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // Retry while Next.js starts.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`S5 e2e app did not become healthy\n${output}`);
}

function headers(idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${authToken}`,
    'x-workspace-id': workspaceId,
    'content-type': 'application/json',
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  };
}

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: headers(init.idempotencyKey),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const payload = (await response.json()) as {
    success: boolean;
    data: T;
    error?: { code?: string };
  };
  expect(response.ok, JSON.stringify(payload)).toBe(true);
  expect(payload.success).toBe(true);
  return payload.data;
}

async function authenticatedPage(
  browser: Browser,
  path: string,
  viewport = { width: 1200, height: 900 },
): Promise<{ page: Page; close: () => Promise<void> }> {
  const session = await fetch(`${baseUrl}/api/console/session`, {
    method: 'POST',
    headers: headers(),
    body: '{}',
  });
  const rawCookie = session.headers.get('set-cookie') ?? '';
  const pair = rawCookie.split(';', 1)[0] ?? '';
  const separator = pair.indexOf('=');
  const context = await browser.newContext({ viewport });
  await context.addCookies([
    {
      name: pair.slice(0, separator),
      value: pair.slice(separator + 1),
      domain: '127.0.0.1',
      path: '/',
      sameSite: 'Strict',
    },
  ]);
  const page = await context.newPage();
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' });
  return { page, close: () => context.close() };
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
      KB_INSTANCE_ID: `s5-e2e-${suffix}`,
      KB_MONGO_URI: requiredEnv('KB_TEST_MONGO_URI'),
      KB_REDIS_URL: requiredEnv('KB_TEST_REDIS_URL'),
      KB_PG_URL: requiredEnv('KB_TEST_PG_URL'),
      KB_S3_ENDPOINT: requiredEnv('KB_TEST_S3_ENDPOINT'),
      KB_S3_REGION: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
      KB_S3_BUCKET: requiredEnv('KB_TEST_S3_BUCKET'),
      KB_S3_ACCESS_KEY_REF: 'env:KB_S5_E2E_S3_ACCESS',
      KB_S3_SECRET_KEY_REF: 'env:KB_S5_E2E_S3_SECRET',
      KB_S5_E2E_S3_ACCESS: requiredEnv('KB_TEST_S3_ACCESS_KEY'),
      KB_S5_E2E_S3_SECRET: requiredEnv('KB_TEST_S3_SECRET_KEY'),
      KB_FILE_PUBLIC_BASE_URL: baseUrl,
      KB_FILE_TICKET_SECRET_REF: 'env:KB_S5_E2E_TICKET_SECRET',
      KB_S5_E2E_TICKET_SECRET: `s5-e2e-ticket-secret-${suffix}-value`,
      KB_CREDENTIAL_ENCRYPTION_KEY_REF: 'env:KB_S5_E2E_CREDENTIAL_KEY',
      KB_S5_E2E_CREDENTIAL_KEY: `s5-e2e-credential-key-${suffix}-value`,
      KB_AUTH_MODE: 'mock',
      KB_MOCK_AUTH_TOKEN: authToken,
      KB_MOCK_WORKSPACE_ID: workspaceId,
      KB_MOCK_MEMBER_ID: memberId,
      KB_MOCK_SCOPES: 'knowledge:read,knowledge:write,knowledge:manage,knowledge:admin',
      KB_MOCK_WORKSPACE_OWNER: 'true',
      KB_EXTERNAL_MODEL_MODE: 'mock',
      KB_EXTERNAL_OCR_MODE: 'mock',
      KB_EXTERNAL_CONNECTOR_MODE: 'mock',
      AIPROXY_MODE: 'compose',
      AIPROXY_BASE_URL: 'http://aiproxy:3000',
      AIPROXY_API_TOKEN_REF: 'env:AIPROXY_API_TOKEN',
      AIPROXY_POSTGRES_URI_REF: 'env:AIPROXY_POSTGRES_URI',
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
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  registerKnowledgeModels(connection);
  const space = await api<{ id: string }>('/v1/knowledge/spaces', {
    method: 'POST',
    idempotencyKey: `s5-space-${suffix}`,
    body: {
      kind: 'space',
      name: `S5 E2E ${suffix}`,
      accessMode: 'workspace',
      sourceAclMode: 'enforced',
      sourcePermissionEnabled: true,
    },
  });
  spaceId = space.id;
}, 180_000);

afterAll(async () => {
  if (processHandle && processHandle.exitCode === null) {
    processHandle.kill('SIGTERM');
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
}, 30_000);

describe('TEST-MODEL-001 / TEST-KB-002 / TEST-X-FRONTEND-IMPORT', () => {
  it('serves model catalog, validation and binding operations through runtime', async () => {
    const catalog = await api<{
      items: Array<{
        modelId: string;
        type: string;
        capabilities: string[];
      }>;
    }>('/v1/knowledge/models?limit=200');
    expect(new Set(catalog.items.map((model) => model.type))).toEqual(
      new Set(['llm', 'embedding', 'rerank', 'vlm', 'stt', 'tts']),
    );
    const embedding = catalog.items.find((model) => model.modelId === 'mock-embedding-1024');
    expect(embedding).toBeDefined();
    const validation = await api<{ valid: boolean; capabilities: string[] }>(
      '/v1/knowledge/model-bindings/validate',
      {
        method: 'POST',
        idempotencyKey: `s5-validate-${suffix}`,
        body: {
          modelId: 'mock-embedding-1024',
          modelType: 'embedding',
          requiredCapabilities: ['text-embedding', 'dimension:1024'],
        },
      },
    );
    expect(validation).toMatchObject({ valid: true });

    const bindings = [
      {
        modelType: 'llm',
        modelId: 'mock-llm-general',
        displayName: 'Mock general LLM',
        requiredCapabilities: ['chat'],
        status: 'active',
      },
      {
        modelType: 'embedding',
        modelId: 'mock-embedding-1024',
        displayName: 'Mock embedding 1024',
        requiredCapabilities: ['dimension:1024', 'text-embedding'],
        status: 'active',
      },
    ];
    const updated = await api<{ items: unknown[]; version: number }>(
      `/v1/knowledge/spaces/${spaceId}/model-bindings`,
      {
        method: 'PUT',
        idempotencyKey: `s5-bindings-${suffix}`,
        body: { bindings, version: 1 },
      },
    );
    expect(updated.items).toHaveLength(2);
    expect(updated.version).toBe(2);
    const read = await api<{ items: Array<{ modelType: string }> }>(
      `/v1/knowledge/spaces/${spaceId}/model-bindings`,
    );
    expect(read.items.map((binding) => binding.modelType)).toEqual(['llm', 'embedding']);
  });

  it('renders the S5 model and parser settings with S4 Import at three viewports', async () => {
    await mkdir(join(root, 'docs', 'acceptance', 's5-ui'), { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
      for (const viewport of [
        { width: 360, height: 800 },
        { width: 768, height: 1024 },
        { width: 1200, height: 900 },
      ]) {
        const session = await authenticatedPage(browser, `/spaces/${spaceId}/import`, viewport);
        await session.page.getByRole('heading', { level: 1, name: '导入知识来源' }).waitFor();
        await session.page.getByRole('region', { name: '解析、切分与 QA' }).waitFor();
        await session.page.getByRole('button', { name: '选择文件' }).waitFor();
        await session.page.getByRole('button', { name: '预览配置' }).click();
        await session.page.getByRole('status').getByText('仅预览配置，不创建解析任务').waitFor();
        expect(
          await session.page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth + 1,
          ),
        ).toBe(false);
        const accessibility = await new AxeBuilder({ page: session.page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(
          accessibility.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          ),
        ).toEqual([]);
        await session.page.screenshot({
          path: join(root, 'docs', 'acceptance', 's5-ui', `s5-model-parse-${viewport.width}.png`),
          fullPage: true,
        });
        await session.close();
      }
    } finally {
      await browser.close();
    }
  });

  it('renders model bindings on Overview after the saved Space version', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const session = await authenticatedPage(browser, `/spaces/${spaceId}/overview`);
      await session.page.getByRole('region', { name: '模型绑定' }).waitFor();
      await session.page.getByText('v2').waitFor();
      await session.close();
    } finally {
      await browser.close();
    }
  });
});
