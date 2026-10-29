import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consoleCookie,
  createSpace,
  startS4App,
  verifyResponsivePage,
  type S4AppHarness,
} from './s4-app-harness';
import {
  createKnowledgeMongoConnection,
  registerKnowledgeModels,
} from '../../packages/service/src';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s10_e2e_${suffix}`;
const memberId = `mem_s10_e2e_${suffix}`;
const authToken = `kb-s10-e2e-token-${suffix}`;

let app: S4AppHarness;
let spaceId = '';
let usageConnection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;

async function jsonRequest(
  path: string,
  input: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    token?: string;
    body?: unknown;
    idempotencyKey?: string;
  } = {},
) {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method: input.method ?? 'GET',
    headers: {
      authorization: `Bearer ${input.token ?? authToken}`,
      'x-workspace-id': workspaceId,
      ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  const payload = (await response.json().catch(() => null)) as
    | { success: true; data: unknown }
    | { success: false; error: { code: string; details?: Record<string, unknown> } }
    | null;
  return { response, payload };
}

beforeAll(async () => {
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  spaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
  usageConnection = await createKnowledgeMongoConnection(process.env.KB_TEST_MONGO_URI ?? '');
  await registerKnowledgeModels(usageConnection).KnowledgeUsageEvent.create({
    workspaceId,
    knowledgeSpaceId: new usageConnection.base.Types.ObjectId(spaceId),
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    eventId: `s10-ui-usage-${suffix}`,
    eventType: 'llm',
    quantity: 1100,
    unit: 'token',
    inputTokens: 1000,
    outputTokens: 100,
    pointsMicros: 1_200_000,
    pricingVersion: 'fixture-v1-ui',
    pricingSnapshot: { name: 'fixture-v1' },
    modelId: 'mock-llm',
    resourceType: 'space',
    resourceId: new usageConnection.base.Types.ObjectId(spaceId),
    jobId: null,
    source: 'console',
    occurredAt: new Date(),
    deliveredAt: null,
    deliveryStatus: 'pending',
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}, 180_000);

afterAll(async () => {
  if (usageConnection) {
    for (const model of Object.values(registerKnowledgeModels(usageConnection))) {
      await model.deleteMany({ workspaceId });
    }
    await usageConnection.close();
  }
  await app?.close();
});

describe('TEST-API-003-BLOCK / TEST-DOWN real scoped HTTP API Key', () => {
  it('uses a real API Key and rejects one-time secret replay', async () => {
    const idempotencyKey = `s10-key-create-${suffix}`;
    const created = await jsonRequest('/v1/knowledge/api-keys', {
      method: 'POST',
      idempotencyKey,
      body: {
        name: 'S10 real scoped key',
        scopes: ['knowledge:read', 'knowledge:search'],
        spaceIds: [spaceId],
      },
    });
    expect(created.response.status).toBe(201);
    expect(created.payload?.success).toBe(true);
    const secretData = created.payload?.success
      ? (created.payload.data as {
          id: string;
          keyPrefix: string;
          version: number;
          secret: string;
        })
      : null;
    expect(secretData?.secret.startsWith('kn_live_')).toBe(true);
    expect(created.response.headers.get('x-request-id')).toBeTruthy();

    const replay = await jsonRequest('/v1/knowledge/api-keys', {
      method: 'POST',
      idempotencyKey,
      body: {
        name: 'S10 real scoped key',
        scopes: ['knowledge:read', 'knowledge:search'],
        spaceIds: [spaceId],
      },
    });
    expect(replay.response.status).toBe(409);
    expect(replay.payload).toMatchObject({
      success: false,
      error: {
        code: 'KNOWLEDGE_CONFLICT',
        details: { reason: 'one_time_secret_already_returned' },
      },
    });

    const listed = await jsonRequest('/v1/knowledge/api-keys?limit=200');
    expect(listed.response.status).toBe(200);
    expect(JSON.stringify(listed.payload)).not.toContain(secretData!.secret);

    const realKeyRead = await jsonRequest(`/v1/knowledge/spaces/${spaceId}`, {
      token: secretData!.secret,
    });
    expect(realKeyRead.response.status).toBe(200);

    const rotated = await jsonRequest(`/v1/knowledge/api-keys/${secretData!.id}/rotate`, {
      method: 'POST',
      idempotencyKey: `${idempotencyKey}-rotate`,
      body: { version: secretData!.version },
    });
    expect(rotated.response.status).toBe(200);
    const rotatedData = rotated.payload?.success
      ? (rotated.payload.data as {
          id: string;
          version: number;
          secret: string;
        })
      : null;
    expect(rotatedData?.secret.startsWith('kn_live_')).toBe(true);
    expect(
      (await jsonRequest(`/v1/knowledge/spaces/${spaceId}`, { token: secretData!.secret })).response
        .status,
    ).toBe(200);
    const revoked = await jsonRequest(
      `/v1/knowledge/api-keys/${rotatedData!.id}?expectedVersion=${rotatedData!.version}`,
      {
        method: 'DELETE',
        idempotencyKey: `${idempotencyKey}-revoke`,
      },
    );
    expect(revoked.response.status).toBe(204);
    expect(
      (
        await jsonRequest(`/v1/knowledge/spaces/${spaceId}`, {
          token: rotatedData!.secret,
        })
      ).response.status,
    ).toBe(401);
    expect(
      (
        await jsonRequest(`/v1/knowledge/spaces/${spaceId}`, {
          token: secretData!.secret,
        })
      ).response.status,
    ).toBe(401);
  });
});

describe('TEST-X-FRONTEND-A11Y S10 ops pages', () => {
  it('renders real API pages at 360/768/1200 without overflow or axe issues', async () => {
    const cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
    for (const [path, prefix] of [
      ['/usage', 's10-usage'],
      ['/audit', 's10-audit'],
      ['/settings/api-keys', 's10-api-keys'],
      ['/system/status', 's10-system'],
    ] as const) {
      await verifyResponsivePage({
        baseUrl: app.baseUrl,
        path,
        cookie,
        screenshotPrefix: prefix,
        resultDir: 's10-ops-admin',
      });
    }
  });

  it('shows the secret once and removes it from DOM, URL and browser storage', async () => {
    const cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await context.addCookies([cookie]);
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      await page.goto(`${app.baseUrl}/settings/api-keys`, { waitUntil: 'networkidle' });
      const inputs = page.locator('input');
      await inputs.nth(0).fill(`UI key ${suffix}`);
      await page.getByRole('button', { name: '创建', exact: true }).click();
      const status = page.getByRole('status');
      await playwrightExpect(status).toBeVisible();
      const secret = await status.locator('code').textContent();
      expect(secret?.startsWith('kn_live_')).toBe(true);
      const mutationCache = page.getByTestId('s10-api-key-mutation-cache');
      await playwrightExpect(mutationCache).toHaveAttribute('data-size', '0');
      await playwrightExpect(mutationCache).toHaveAttribute('data-secret-present', 'false');
      await page.getByRole('button', { name: '关闭并清除', exact: true }).click();
      await playwrightExpect(page.getByText(secret!, { exact: true })).toHaveCount(0);
      await playwrightExpect(mutationCache).toHaveAttribute('data-size', '0');
      await playwrightExpect(mutationCache).toHaveAttribute('data-secret-present', 'false');
      const storageDump = await page.evaluate(() => ({
        local: { ...localStorage },
        session: { ...sessionStorage },
        url: location.href,
      }));
      expect(JSON.stringify(storageDump)).not.toContain(secret!);
      await page.reload({ waitUntil: 'networkidle' });
      await playwrightExpect(page.getByText(secret!, { exact: true })).toHaveCount(0);
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(
        accessibility.violations.filter(
          (violation) => violation.impact === 'serious' || violation.impact === 'critical',
        ),
      ).toEqual([]);
      expect(consoleErrors).toEqual([]);
      await context.close();
    } finally {
      await browser.close();
    }
  });

  it('renders the Usage ECharts canvas from canonical API data', async () => {
    const cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await context.addCookies([cookie]);
      const page = await context.newPage();
      await page.goto(`${app.baseUrl}/usage`, { waitUntil: 'networkidle' });
      const canvas = page.locator('canvas').first();
      await playwrightExpect(canvas).toBeVisible();
      const nonblank = await canvas.evaluate((element) => {
        const target = element as HTMLCanvasElement;
        const context2d = target.getContext('2d');
        if (!context2d) return false;
        const pixels = context2d.getImageData(0, 0, target.width, target.height).data;
        for (let index = 3; index < pixels.length; index += 4) {
          if (pixels[index] !== 0) return true;
        }
        return false;
      });
      expect(nonblank).toBe(true);
      await context.close();
    } finally {
      await browser.close();
    }
  });

  it('shows the submitted cleanup Job id from the canonical 202 response', async () => {
    const cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await context.addCookies([cookie]);
      const page = await context.newPage();
      await page.goto(`${app.baseUrl}/system/status`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '创建清理 Job', exact: true }).click();
      const submitted = page.getByRole('status').filter({ hasText: '已提交 Job' });
      await playwrightExpect(submitted).toBeVisible();
      await playwrightExpect(submitted).toContainText(/[a-f0-9]{24}/);
      await context.close();
    } finally {
      await browser.close();
    }
  });
});

describe('TEST-OPS-005-BLOCK S10 status and observability APIs', () => {
  it('returns real dependency probes, fixture verification and no fake healthy', async () => {
    const status = await jsonRequest('/v1/knowledge/operations/status');
    expect(status.response.status).toBe(200);
    const data = status.payload?.success
      ? (status.payload.data as {
          status: string;
          dependencies: Record<string, { status: string; verificationStatus: string }>;
          modelProbe: { verificationStatus: string };
          securityChecks: Record<string, boolean>;
          reconciliation: { state: string };
        })
      : null;
    expect(data?.dependencies.mongo).toMatchObject({
      status: 'ok',
      verificationStatus: 'REAL_VERIFIED',
    });
    expect(data?.modelProbe.verificationStatus).toBe('FIXTURE_VERIFIED');
    expect(data?.status).toBe('degraded');
    expect(data?.securityChecks).toMatchObject({
      apiKeyHmacConfigured: true,
      scopeEnforced: true,
      auditAppendOnly: true,
      secretRedactionEnabled: true,
      rateLimitEnabled: true,
    });

    const usage = await jsonRequest('/v1/knowledge/usage');
    expect(usage.response.status).toBe(200);
    expect(usage.payload).toMatchObject({
      success: true,
      data: {
        quota: { profileVersion: expect.any(String) },
        usage: { aiPointsMicros: expect.any(Number) },
        profileVersion: expect.any(String),
      },
    });
    const audit = await jsonRequest('/v1/knowledge/audit-events?limit=10');
    expect(audit.response.status).toBe(200);
    expect(audit.payload).toMatchObject({
      success: true,
      data: { items: expect.any(Array), pageInfo: expect.any(Object) },
    });

    const restricted = await jsonRequest('/v1/knowledge/api-keys', {
      method: 'POST',
      idempotencyKey: `s10-status-restricted-${suffix}`,
      body: {
        name: 'Restricted status key',
        scopes: ['knowledge:admin'],
        spaceIds: [spaceId],
      },
    });
    const restrictedSecret = restricted.payload?.success
      ? (restricted.payload.data as { secret: string }).secret
      : '';
    const deniedStatus = await jsonRequest('/v1/knowledge/operations/status', {
      token: restrictedSecret,
    });
    expect(deniedStatus.response.status).toBe(403);
    expect(deniedStatus.payload).toMatchObject({
      success: false,
      error: {
        code: 'KNOWLEDGE_FORBIDDEN',
        details: { reason: 'workspace_wide_api_key_required' },
      },
    });

    const cleanup = await jsonRequest('/v1/knowledge/operations/cleanup', {
      method: 'POST',
      idempotencyKey: `s10-status-cleanup-${suffix}`,
      body: { scope: 'stale_jobs' },
    });
    expect(cleanup.response.status, JSON.stringify(cleanup.payload)).toBe(202);
    expect(cleanup.payload).toMatchObject({
      success: true,
      data: {
        jobId: expect.stringMatching(/^[a-f0-9]{24}$/),
        workspaceId,
        knowledgeSpaceId: '000000000000000000000000',
        kind: 'cleanup',
        status: expect.any(String),
        operationId: 'API-OPS-CLEANUP',
        priority: 5,
        attempts: expect.any(Number),
        maxAttempts: 5,
        progress: {
          stage: expect.any(String),
          completed: expect.any(Number),
          total: 1,
          percent: expect.any(Number),
        },
        resourceType: 'workspace',
        resourceId: '000000000000000000000000',
        version: expect.any(Number),
      },
    });
  });
});
