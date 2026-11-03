import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { apiHeaders, createSpace, startS4App, type S4AppHarness } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');

export const S11_REQUIRED_PROVIDER_INPUTS = [
  'S11_PROVIDER_MODE=real',
  'AIPROXY_BASE_URL',
  'AIPROXY_API_TOKEN',
  'S11_AIPROXY_LLM_MODEL',
  'S11_AIPROXY_EMBEDDING_MODEL',
  'S11_AIPROXY_RERANK_MODEL',
  'S11_AIPROXY_VLM_MODEL',
  'S11_AIPROXY_VISION_EMBEDDING_MODEL',
  'AIPROXY_MODEL_PROFILE_JSON',
  'S11_AIPROXY_MODEL_MAPPING_APPROVED=true',
  'S11_OCR_SOMARK_PROFILE_JSON',
  'S11_OCR_TEXTIN_PROFILE_JSON',
  'S11_OCR_DOC2X_PROFILE_JSON',
  'S11_FEISHU_APP_ID',
  'S11_FEISHU_APP_SECRET',
  'S11_FEISHU_FOLDER_TOKEN',
  'S11_FEISHU_DOC_1',
  'S11_FEISHU_DOC_2',
] as const;

export interface S11FixtureManifest {
  schemaVersion: 1;
  seed: string;
  fixtureHash: string;
  entries: Array<{
    name: string;
    sha256: string;
    bytes: number;
    pageCount: number | null;
    mimeType: string;
    purpose: string[];
  }>;
}

export interface S11Stack {
  status: 'READY';
  app: S4AppHarness;
  apiKey: {
    id: string;
    secret: string;
    keyPrefix: string;
  };
  spaceId: string;
  workspaceId: string;
  cleanup(): Promise<void>;
}

export interface S11BlockedStack {
  status: 'BLOCKED';
  blockers: Array<{
    code: string;
    provider: string | null;
    missingFields: string[];
  }>;
}

export type S11StackStartResult = S11Stack | S11BlockedStack;

export function loadS11FixtureManifest(): S11FixtureManifest {
  return JSON.parse(
    readFileSync(join(root, 'test', 'fixtures', 's11', 'fixture-manifest.json'), 'utf8'),
  ) as S11FixtureManifest;
}

export function missingRealProviderFields(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const missing = S11_REQUIRED_PROVIDER_INPUTS.filter((requirement) => {
    const [name, expected] = requirement.split('=', 2);
    const value = name ? env[name]?.trim() : undefined;
    return expected === undefined ? !value : value !== expected;
  });
  return missing;
}

function missingRuntimeFields(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return [
    'KB_TEST_MONGO_URI',
    'KB_TEST_REDIS_URL',
    'KB_TEST_PG_URL',
    'KB_TEST_S3_ENDPOINT',
    'KB_TEST_S3_BUCKET',
    'KB_TEST_S3_ACCESS_KEY',
    'KB_TEST_S3_SECRET_KEY',
  ].filter((name) => !env[name]?.trim());
}

export async function createRealApiKey(input: {
  baseUrl: string;
  workspaceId: string;
  spaceId: string;
  bootstrapToken: string;
  idempotencyKey?: string;
}): Promise<{ id: string; secret: string; keyPrefix: string }> {
  const response = await fetch(`${input.baseUrl}/v1/knowledge/api-keys`, {
    method: 'POST',
    headers: {
      ...apiHeaders({
        authToken: input.bootstrapToken,
        workspaceId: input.workspaceId,
        idempotencyKey: input.idempotencyKey ?? `s11-api-key-${randomUUID()}`,
      }),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'S11 real-provider gate',
      scopes: ['knowledge:read', 'knowledge:write', 'knowledge:search', 'knowledge:manage'],
      spaceIds: [input.spaceId],
      expiresAt: null,
    }),
  });
  const payload = (await response.json()) as {
    success?: boolean;
    data?: { id?: string; secret?: string; keyPrefix?: string };
  };
  if (
    response.status !== 201 ||
    !payload.success ||
    !payload.data?.id ||
    !payload.data.secret ||
    !payload.data.keyPrefix
  ) {
    throw new Error(
      `S11_API_KEY_CREATE_FAILED status=${response.status} safeCode=${String(
        (payload as { error?: { code?: string } }).error?.code ?? 'UNKNOWN',
      )}`,
    );
  }
  return {
    id: payload.data.id,
    secret: payload.data.secret,
    keyPrefix: payload.data.keyPrefix,
  };
}

export async function waitJob(input: {
  baseUrl: string;
  workspaceId: string;
  apiKeySecret: string;
  jobId: string;
  timeoutMs?: number;
}): Promise<{ status: string; result: unknown }> {
  const deadline = Date.now() + (input.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    const response = await fetch(`${input.baseUrl}/v1/knowledge/jobs/${input.jobId}`, {
      headers: apiHeaders({
        authToken: input.apiKeySecret,
        workspaceId: input.workspaceId,
      }),
    });
    if (!response.ok) {
      throw new Error(`S11_JOB_READ_FAILED status=${response.status}`);
    }
    const payload = (await response.json()) as {
      data?: { status?: string; result?: unknown };
    };
    const status = payload.data?.status;
    if (status && ['succeeded', 'partial', 'failed', 'dead_letter'].includes(status)) {
      return { status, result: payload.data?.result ?? null };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`S11_JOB_TIMEOUT jobId=${input.jobId}`);
}

export async function cleanupWorkspace(input: {
  baseUrl: string;
  workspaceId: string;
  apiKeySecret: string;
  spaceId: string;
}): Promise<void> {
  const response = await fetch(`${input.baseUrl}/v1/knowledge/spaces/${input.spaceId}`, {
    method: 'DELETE',
    headers: apiHeaders({
      authToken: input.apiKeySecret,
      workspaceId: input.workspaceId,
      idempotencyKey: `s11-cleanup-${input.spaceId}`,
    }),
  });
  if (![200, 202, 204, 404].includes(response.status)) {
    throw new Error(`S11_WORKSPACE_CLEANUP_FAILED status=${response.status}`);
  }
}

export async function startS11Stack(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ stack: S11StackStartResult; manifest: S11FixtureManifest }> {
  const manifest = loadS11FixtureManifest();
  const fixtureRoot = join(root, 'test', 'fixtures', 's11', 'generated');
  for (const entry of manifest.entries) {
    if (!existsSync(join(fixtureRoot, entry.name))) {
      return {
        manifest,
        stack: {
          status: 'BLOCKED',
          blockers: [
            {
              code: 'S11_FIXTURE_MISSING',
              provider: null,
              missingFields: [entry.name],
            },
          ],
        },
      };
    }
  }
  if (env.S11_E2E_MODE !== 'real') {
    return {
      manifest,
      stack: {
        status: 'BLOCKED',
        blockers: [
          {
            code: 'REAL_PROVIDER_BLOCKED',
            provider: null,
            missingFields: ['S11_E2E_MODE=real', ...missingRealProviderFields(env)],
          },
        ],
      },
    };
  }
  const missingRuntime = missingRuntimeFields(env);
  const missingProviders = missingRealProviderFields(env);
  if (missingRuntime.length > 0 || missingProviders.length > 0) {
    return {
      manifest,
      stack: {
        status: 'BLOCKED',
        blockers: [
          ...(missingRuntime.length > 0
            ? [
                {
                  code: 'PERFORMANCE_STACK_UNAVAILABLE',
                  provider: null,
                  missingFields: missingRuntime,
                },
              ]
            : []),
          ...(missingProviders.length > 0
            ? [
                {
                  code: 'REAL_PROVIDER_BLOCKED',
                  provider: null,
                  missingFields: missingProviders,
                },
              ]
            : []),
        ],
      },
    };
  }

  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workspaceId = `ws_s11_e2e_${suffix}`;
  const memberId = `mem_s11_e2e_${suffix}`;
  const bootstrapToken = `s11-bootstrap-${suffix}`;
  const app = await startS4App({ suffix, workspaceId, memberId, authToken: bootstrapToken });
  try {
    const spaceId = await createSpace({
      baseUrl: app.baseUrl,
      authToken: bootstrapToken,
      workspaceId,
      suffix,
    });
    const apiKey = await createRealApiKey({
      baseUrl: app.baseUrl,
      workspaceId,
      spaceId,
      bootstrapToken,
    });
    return {
      manifest,
      stack: {
        status: 'READY',
        app,
        apiKey,
        spaceId,
        workspaceId,
        async cleanup() {
          await cleanupWorkspace({
            baseUrl: app.baseUrl,
            workspaceId,
            apiKeySecret: apiKey.secret,
            spaceId,
          });
          await app.close();
        },
      },
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}
