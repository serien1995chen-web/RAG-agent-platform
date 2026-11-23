import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as uiExpect } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createKnowledgeMongoConnection,
  registerKnowledgeModels,
} from '../../packages/service/src';
import { consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b20_ui_${suffix}`;
const memberId = `mem_b20_ui_${suffix}`;
const authToken = `b20-ui-token-${suffix}`;
const runId = process.env.B20_RUN_ID?.trim() || '20261123-190322';
const resultRoot = resolve(import.meta.dirname, '../..', 'test-results', 'b20', runId, 'ui');
let app: S4AppHarness;
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;

beforeAll(async () => {
  app = await startS4App({
    suffix: `b20-${suffix}`,
    workspaceId,
    memberId,
    authToken,
    connectorMode: 'mock',
    pricingProfile: 'fixture-v1',
  });
  connection = await createKnowledgeMongoConnection(process.env.KB_TEST_MONGO_URI ?? '');
  const models = registerKnowledgeModels(connection);
  const knowledgeSpaceId = new connection.base.Types.ObjectId();
  const now = new Date();
  await models.KnowledgeUsageEvent.create({
    workspaceId,
    knowledgeSpaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    eventId: `b20-ui-usage-${suffix}`,
    eventType: 'embedding',
    quantity: 1024,
    unit: 'token',
    inputTokens: 1024,
    outputTokens: 0,
    pointsMicros: 1_200_000,
    pricingVersion: 'fixture-v1',
    pricingSnapshot: { name: 'fixture-v1', version: 'fixture-v1' },
    modelId: 'qwen3.7-text-embedding',
    resourceType: 'space',
    resourceId: knowledgeSpaceId,
    jobId: null,
    source: 'console',
    occurredAt: now,
    deliveredAt: null,
    deliveryStatus: 'pending',
    expiresAt: new Date(now.getTime() + 86_400_000),
  });
  await models.KnowledgeAuditEvent.create({
    workspaceId,
    knowledgeSpaceId,
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    eventId: `b20-ui-audit-${suffix}`,
    action: 'model.invoke',
    resourceType: 'space',
    resourceId: knowledgeSpaceId,
    outcome: 'failed',
    traceId: suffix.padEnd(32, '0').slice(0, 32),
    requestId: `b20-ui-request-${suffix}`,
    ipHash: 'safe-ip-hash',
    userAgentHash: 'safe-agent-hash',
    actorMemberId: memberId,
    apiKeyId: null,
    apiKeyPrefix: null,
    safeDiff: {
      provider: 'aiproxy',
      kind: 'vlm',
      quantity: 1,
      unit: 'image',
      status: 503,
      attempt: 2,
      fallbackUsed: true,
    },
    occurredAt: now,
    expiresAt: new Date(now.getTime() + 86_400_000),
  });
  await models.KnowledgeJob.create({
    workspaceId,
    knowledgeSpaceId,
    version: 3,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    kind: 'caption',
    operationId: 'L1-B20-OPS-002',
    idempotencyKey: `b20-ui-job-${suffix}`,
    resourceType: 'space',
    resourceId: String(knowledgeSpaceId),
    status: 'dead_letter',
    priority: 0,
    attempts: 3,
    maxAttempts: 3,
    attemptEpoch: 3,
    fencingToken: `b20-fence-${suffix}`,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    availableAt: now,
    cancelRequestedAt: null,
    pausedAt: null,
    progress: { stage: 'image_index', completed: 0, total: 1, percent: 0 },
    inputSnapshot: { sourceId: String(knowledgeSpaceId), sourceVersion: 1 },
    steps: [],
    error: { code: 'KNOWLEDGE_MODEL_FAILED', retryable: false },
    result: null,
    expiresAt: new Date(now.getTime() + 86_400_000),
  });
}, 240_000);

afterAll(async () => {
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
  await app?.close();
});

describe('L1-B20-OPS-002 UI operations and usage governance', () => {
  it('L1-B20-OPS-002-UI01 exposes admin usage, failures, delivery and replay from a refreshable product entry', async () => {
    await mkdir(resultRoot, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 1200, height: 900 },
        locale: 'zh-CN',
      });
      await context.addCookies([
        await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId }),
      ]);
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      await page.goto(`${app.baseUrl}/spaces`, { waitUntil: 'networkidle' });
      const operationsEntry = page
        .getByRole('link', { name: /用量|运营|Usage|Operations/i })
        .or(page.getByRole('button', { name: /用量|运营|Usage|Operations/i }));
      const entryVisible = await operationsEntry
        .first()
        .isVisible()
        .catch(() => false);
      await page.screenshot({ path: join(resultRoot, 'spaces-entry-1200x900.png') });
      await writeFile(
        join(resultRoot, 'operations-entry.json'),
        `${JSON.stringify(
          {
            capabilityId: 'OPS-002',
            subtestId: 'L1-B20-OPS-002-UI01',
            route: '/spaces',
            operationsEntryVisible: entryVisible,
            consoleErrors,
            checkedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );
      uiExpect(
        entryVisible,
        'No usage/operations entry is exposed in the current product console.',
      ).toBe(true);
      await operationsEntry.first().click();
      await page.waitForURL(/\/settings\/operations/);
      await page.waitForLoadState('networkidle');
      await uiExpect(page.getByRole('heading', { name: '运营与用量' }).first()).toBeVisible();
      await uiExpect(page.getByText('1.200000').first()).toBeVisible();
      await uiExpect(page.getByText('aiproxy').first()).toBeVisible();
      await uiExpect(page.getByText('dead_letter').first()).toBeVisible();
      await uiExpect(page.getByRole('button', { name: '重放' }).first()).toBeVisible();
      for (const viewport of [
        { width: 360, height: 800 },
        { width: 768, height: 900 },
        { width: 1200, height: 900 },
      ]) {
        await page.setViewportSize(viewport);
        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
        await page.screenshot({
          path: join(resultRoot, `operations-${viewport.width}x${viewport.height}.png`),
        });
      }
      await page.reload({ waitUntil: 'networkidle' });
      await uiExpect(page.getByRole('heading', { name: '运营与用量' }).first()).toBeVisible();
      await uiExpect(page.getByText('aiproxy').first()).toBeVisible();
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
  }, 300_000);

  it('L1-B20-OPS-002-UI01 hides global operations data from a read-only member', async () => {
    const readOnlyWorkspace = `ws_b20_ui_read_${suffix}`;
    const readOnlyMember = `mem_b20_ui_read_${suffix}`;
    const readOnlyToken = `b20-ui-read-token-${suffix}`;
    const readOnlyApp = await startS4App({
      suffix: `b20-read-${suffix}`,
      workspaceId: readOnlyWorkspace,
      memberId: readOnlyMember,
      authToken: readOnlyToken,
      scopes: 'knowledge:read',
      isWorkspaceOwner: false,
    });
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await context.addCookies([
        await consoleCookie({
          baseUrl: readOnlyApp.baseUrl,
          authToken: readOnlyToken,
          workspaceId: readOnlyWorkspace,
        }),
      ]);
      const page = await context.newPage();
      await page.goto(`${readOnlyApp.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
      await uiExpect(page.getByRole('link', { name: '运营' })).toHaveCount(0);
      await page.goto(`${readOnlyApp.baseUrl}/settings/operations`, { waitUntil: 'networkidle' });
      await uiExpect(page.getByText('需要管理员权限')).toBeVisible();
      await uiExpect(page.getByText('aiproxy')).toHaveCount(0);
      await context.close();
    } finally {
      await browser.close();
      await readOnlyApp.close();
    }
  }, 300_000);
});
