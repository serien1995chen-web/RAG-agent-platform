import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const appRoot = join(root, 'projects', 'app');
const WORKER_MARKER = '/tmp/knowledge-worker-ready';

export interface B06aAppHarness {
  baseUrl: string;
  output(): string;
  close(): Promise<void>;
}

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

function baseRuntimeEnv(input: {
  suffix: string;
  workspaceId: string;
  memberId: string;
  authToken: string;
  scopes?: string;
  isWorkspaceOwner?: boolean;
  port: number;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    KB_ENV: 'test',
    KB_APP_WORKER_MODE: 'http',
    KB_PORT: String(input.port),
    KB_INSTANCE_ID: `b06a-e2e-${input.suffix}`,
    KB_MONGO_URI: requiredEnv('KB_TEST_MONGO_URI'),
    KB_REDIS_URL: requiredEnv('KB_TEST_REDIS_URL'),
    KB_PG_URL: requiredEnv('KB_TEST_PG_URL'),
    KB_S3_ENDPOINT: requiredEnv('KB_TEST_S3_ENDPOINT'),
    KB_S3_REGION: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
    KB_S3_BUCKET: requiredEnv('KB_TEST_S3_BUCKET'),
    KB_S3_ACCESS_KEY_REF: 'env:KB_B06A_E2E_S3_ACCESS',
    KB_S3_SECRET_KEY_REF: 'env:KB_B06A_E2E_S3_SECRET',
    KB_B06A_E2E_S3_ACCESS: requiredEnv('KB_TEST_S3_ACCESS_KEY'),
    KB_B06A_E2E_S3_SECRET: requiredEnv('KB_TEST_S3_SECRET_KEY'),
    KB_FILE_PUBLIC_BASE_URL: `http://127.0.0.1:${input.port}`,
    KB_FILE_TICKET_SECRET_REF: 'env:KB_B06A_E2E_TICKET_SECRET',
    KB_B06A_E2E_TICKET_SECRET: `b06a-e2e-ticket-secret-${input.suffix}-value`,
    KB_CREDENTIAL_ENCRYPTION_KEY_REF: 'env:KB_B06A_E2E_CREDENTIAL_KEY',
    KB_B06A_E2E_CREDENTIAL_KEY: `b06a-e2e-credential-key-${input.suffix}-value`,
    KB_CITATION_SIGNING_SECRET_REF: 'env:KB_S7_E2E_CITATION_SECRET',
    KB_S7_E2E_CITATION_SECRET: `s7-e2e-citation-secret-${input.suffix}-value`,
    KB_AUTH_MODE: 'mock',
    KB_MOCK_AUTH_TOKEN: input.authToken,
    API_KEY_HMAC_SECRET_FILE: `${root}/test/fixtures/s10/api-key-hmac.secret`,
    KB_MOCK_WORKSPACE_ID: input.workspaceId,
    KB_MOCK_MEMBER_ID: input.memberId,
    KB_MOCK_SCOPES:
      input.scopes ?? 'knowledge:read,knowledge:write,knowledge:manage,knowledge:admin',
    KB_MOCK_WORKSPACE_OWNER: String(input.isWorkspaceOwner ?? true),
    KB_EXTERNAL_MODEL_MODE: 'mock',
    KB_EXTERNAL_OCR_MODE: 'mock',
    KB_EXTERNAL_CONNECTOR_MODE: 'mock',
    KB_LOG_LEVEL: 'error',
  };
}

async function waitForHealth(handle: ChildProcess, baseUrl: string, output: () => string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (handle.exitCode !== null) {
      throw new Error(`B06A e2e app exited early\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // Next.js is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`B06A e2e app did not become healthy\n${output()}`);
}

async function waitForWorker(worker: ChildProcess, output: () => string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) {
      throw new Error(`B06A worker exited early\n${output()}`);
    }
    if (existsSync(WORKER_MARKER)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`B06A worker did not become ready\n${output()}`);
}

export async function startB06aApp(input: {
  suffix: string;
  workspaceId: string;
  memberId: string;
  authToken: string;
  scopes?: string;
  isWorkspaceOwner?: boolean;
  withWorker?: boolean;
}): Promise<B06aAppHarness> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const nextBinary = join(appRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBinary)) throw new Error(`Next binary not found: ${nextBinary}`);
  let output = '';
  const collect = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-30_000);
  };
  const handle = spawn(process.execPath, [nextBinary, 'start', '-p', String(port)], {
    cwd: appRoot,
    env: baseRuntimeEnv({ ...input, port }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  handle.stdout?.on('data', collect);
  handle.stderr?.on('data', collect);
  await waitForHealth(handle, baseUrl, () => output);

  let worker: ChildProcess | null = null;
  if (input.withWorker !== false) {
    const workerEntry = join(appRoot, 'dist', 'workers', 'worker.mjs');
    if (!existsSync(workerEntry)) {
      throw new Error(`worker build missing: ${workerEntry} (run pnpm build:workers)`);
    }
    rmSync(WORKER_MARKER, { force: true });
    worker = spawn(process.execPath, [workerEntry], {
      cwd: appRoot,
      env: {
        ...baseRuntimeEnv({ ...input, port }),
        KB_APP_WORKER_MODE: 'worker',
        KB_INSTANCE_ID: `b06a-e2e-worker-${input.suffix}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    worker.stdout?.on('data', collect);
    worker.stderr?.on('data', collect);
    await waitForWorker(worker, () => output);
  }

  return {
    baseUrl,
    output: () => output,
    async close() {
      if (worker && worker.exitCode === null) {
        worker.kill('SIGTERM');
        await new Promise((resolveWait) => setTimeout(resolveWait, 800));
        if (worker.exitCode === null) worker.kill('SIGKILL');
      }
      rmSync(WORKER_MARKER, { force: true });
      if (handle.exitCode === null) {
        handle.kill('SIGTERM');
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      }
    },
  };
}
