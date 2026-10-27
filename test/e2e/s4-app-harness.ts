import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type Page } from '@playwright/test';
import { expect } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const appRoot = join(root, 'projects', 'app');

export interface S4AppHarness {
  baseUrl: string;
  output(): string;
  close(): Promise<void>;
}

export function requiredEnv(name: string): string {
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

async function waitForHealth(handle: ChildProcess, baseUrl: string, output: () => string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (handle.exitCode !== null) {
      throw new Error(`S4 e2e app exited early\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // Next.js is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`S4 e2e app did not become healthy\n${output()}`);
}

export async function startS4App(input: {
  suffix: string;
  workspaceId: string;
  memberId: string;
  authToken: string;
}): Promise<S4AppHarness> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const nextBinary = join(appRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBinary)) throw new Error(`Next binary not found: ${nextBinary}`);
  let output = '';
  const handle = spawn(process.execPath, [nextBinary, 'start', '-p', String(port)], {
    cwd: appRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      KB_ENV: 'test',
      KB_APP_WORKER_MODE: 'http',
      KB_PORT: String(port),
      KB_INSTANCE_ID: `s4-e2e-${input.suffix}`,
      KB_MONGO_URI: requiredEnv('KB_TEST_MONGO_URI'),
      KB_REDIS_URL: requiredEnv('KB_TEST_REDIS_URL'),
      KB_PG_URL: requiredEnv('KB_TEST_PG_URL'),
      KB_S3_ENDPOINT: requiredEnv('KB_TEST_S3_ENDPOINT'),
      KB_S3_REGION: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
      KB_S3_BUCKET: requiredEnv('KB_TEST_S3_BUCKET'),
      KB_S3_ACCESS_KEY_REF: 'env:KB_S4_E2E_S3_ACCESS',
      KB_S3_SECRET_KEY_REF: 'env:KB_S4_E2E_S3_SECRET',
      KB_S4_E2E_S3_ACCESS: requiredEnv('KB_TEST_S3_ACCESS_KEY'),
      KB_S4_E2E_S3_SECRET: requiredEnv('KB_TEST_S3_SECRET_KEY'),
      KB_FILE_PUBLIC_BASE_URL: baseUrl,
      KB_FILE_TICKET_SECRET_REF: 'env:KB_S4_E2E_TICKET_SECRET',
      KB_S4_E2E_TICKET_SECRET: `s4-e2e-ticket-secret-${input.suffix}-value`,
      KB_CREDENTIAL_ENCRYPTION_KEY_REF: 'env:KB_S4_E2E_CREDENTIAL_KEY',
      KB_S4_E2E_CREDENTIAL_KEY: `s4-e2e-credential-key-${input.suffix}-value`,
      KB_AUTH_MODE: 'mock',
      KB_MOCK_AUTH_TOKEN: input.authToken,
      KB_MOCK_WORKSPACE_ID: input.workspaceId,
      KB_MOCK_MEMBER_ID: input.memberId,
      KB_MOCK_SCOPES: 'knowledge:read,knowledge:write,knowledge:manage,knowledge:admin',
      KB_MOCK_WORKSPACE_OWNER: 'true',
      KB_EXTERNAL_MODEL_MODE: 'mock',
      KB_EXTERNAL_OCR_MODE: 'mock',
      KB_EXTERNAL_CONNECTOR_MODE: 'mock',
      KB_LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  handle.stdout?.on('data', (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-20_000);
  });
  handle.stderr?.on('data', (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-20_000);
  });
  await waitForHealth(handle, baseUrl, () => output);
  return {
    baseUrl,
    output: () => output,
    async close() {
      if (handle.exitCode === null) {
        handle.kill('SIGTERM');
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      }
    },
  };
}

export function apiHeaders(input: {
  authToken: string;
  workspaceId: string;
  idempotencyKey?: string;
}): Record<string, string> {
  return {
    authorization: `Bearer ${input.authToken}`,
    'x-workspace-id': input.workspaceId,
    ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
  };
}

export async function createSpace(input: {
  baseUrl: string;
  authToken: string;
  workspaceId: string;
  suffix: string;
}): Promise<string> {
  const response = await fetch(`${input.baseUrl}/v1/knowledge/spaces`, {
    method: 'POST',
    headers: {
      ...apiHeaders(input),
      'content-type': 'application/json',
      'idempotency-key': `s4-space-${input.suffix}`,
    },
    body: JSON.stringify({
      kind: 'space',
      name: `S4 E2E ${input.suffix}`,
      accessMode: 'workspace',
      sourceAclMode: 'inherited',
      sourcePermissionEnabled: true,
    }),
  });
  const payload = (await response.json()) as { success: boolean; data: { id: string } };
  if (!response.ok || !payload.success) {
    throw new Error(
      `createSpace failed: status=${response.status} body=${JSON.stringify(payload)}`,
    );
  }
  return payload.data.id;
}

export async function consoleCookie(input: {
  baseUrl: string;
  authToken: string;
  workspaceId: string;
}) {
  const response = await fetch(`${input.baseUrl}/api/console/session`, {
    method: 'POST',
    headers: {
      ...apiHeaders(input),
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const raw = response.headers.get('set-cookie') ?? '';
  const pair = raw.split(';', 1)[0] ?? '';
  const separator = pair.indexOf('=');
  return {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    domain: '127.0.0.1',
    path: '/',
    sameSite: 'Strict' as const,
  };
}

export async function verifyResponsivePage(input: {
  baseUrl: string;
  path: string;
  cookie: Awaited<ReturnType<typeof consoleCookie>>;
  screenshotPrefix: string;
  resultDir?: string;
}): Promise<void> {
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [
      { width: 360, height: 800 },
      { width: 768, height: 900 },
      { width: 1200, height: 900 },
    ]) {
      const context = await browser.newContext({ viewport });
      await context.addCookies([input.cookie]);
      const page: Page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      await page.goto(`${input.baseUrl}${input.path}`, { waitUntil: 'networkidle' });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      const overflowDetails = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('body *'))
          .filter((element) => {
            const bounds = element.getBoundingClientRect();
            return bounds.right > document.documentElement.clientWidth + 1;
          })
          .slice(0, 8)
          .map((element) => ({
            tag: element.tagName,
            className: element.className,
            text: element.textContent?.trim().slice(0, 80),
            right: Math.round(element.getBoundingClientRect().right),
          })),
      );
      expect(
        overflow,
        `${viewport.width}px horizontal overflow ${JSON.stringify(overflowDetails)}`,
      ).toBeLessThanOrEqual(1);
      const resultDir = input.resultDir ?? 's4-ui';
      await mkdir(join(root, 'test-results', resultDir), { recursive: true });
      await page.screenshot({
        path: join(
          root,
          'test-results',
          resultDir,
          `${input.screenshotPrefix}-${viewport.width}.png`,
        ),
        fullPage: true,
      });
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(
        accessibility.violations.filter(
          (violation) => violation.impact === 'serious' || violation.impact === 'critical',
        ),
      ).toEqual([]);
      expect(consoleErrors).toEqual([]);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
