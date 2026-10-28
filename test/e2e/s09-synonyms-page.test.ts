import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createKnowledgeMongoConnection,
  registerKnowledgeModels,
  type TenantContext,
} from '../../packages/service/src';
import {
  rebuildResult,
  type SynonymStagedRebuild,
} from '../../packages/service/src/modules/knowledge/domain/s09-synonym-rebuild';
import { KnowledgeSynonymRepository } from '../../packages/service/src/modules/knowledge/repository/s09-synonym.repository';
import {
  apiHeaders,
  consoleCookie,
  createSpace,
  startS4App,
  type S4AppHarness,
} from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const outputDir = join(root, 'test-results', 's09-synonyms-real-ui');
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s9_page_${suffix}`;
const memberId = `mem_s9_page_${suffix}`;
const authToken = `kb-s9-page-token-${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId,
  requestId: `req_s9_page_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:manage', 'knowledge:admin'],
  isWorkspaceOwner: true,
};

let app: S4AppHarness;
let browser: Browser;
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
let spaceId = '';

async function seedSynonyms() {
  const body = new FormData();
  body.set(
    'file',
    new File([Buffer.from('标准词,同义词\n退款,退货\n配送,发货\n')], 'synonyms.csv', {
      type: 'text/csv',
    }),
  );
  body.set('enabled', 'true');
  const response = await fetch(`${app.baseUrl}/v1/knowledge/spaces/${spaceId}/synonyms/files`, {
    method: 'POST',
    headers: apiHeaders({
      authToken,
      workspaceId,
      idempotencyKey: `s9-page-seed-${suffix}`,
    }),
    body,
  });
  expect(response.status).toBe(201);
  const models = registerKnowledgeModels(connection);
  const job = await models.KnowledgeJob.findOne({
    workspaceId,
    kind: 'synonym_rebuild',
    status: 'queued',
  });
  expect(job).toBeTruthy();
  await models.KnowledgeJob.updateOne(
    { _id: job!._id, workspaceId, status: 'queued' },
    {
      $set: {
        status: 'running',
        leaseOwner: `s9-page-${suffix}`,
        leaseExpiresAt: new Date(Date.now() + 300_000),
        fencingToken: randomUUID(),
      },
      $inc: { version: 1, attemptEpoch: 1, attempts: 1 },
    },
  );
  const repository = new KnowledgeSynonymRepository(connection);
  const plan = await repository.getRebuildPlan(String(job!._id), context);
  const staged: SynonymStagedRebuild = {
    stagingId: `s9-page-stage-${job!._id}`,
    workspaceId,
    knowledgeSpaceId: plan.knowledgeSpaceId,
    candidateFileVersion: plan.candidateFileVersion,
    sourceIds: plan.sourceIds,
    indexedSegmentVersions: {},
    reusedVectorCount: 0,
    rebuiltCount: 0,
    cleanupCandidates: [],
    failureEvidence: null,
  };
  await repository.completeRebuild(plan, staged, rebuildResult(plan, staged), context);
}

beforeAll(async () => {
  mkdirSync(outputDir, { recursive: true });
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  spaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
  connection = await createKnowledgeMongoConnection(process.env.KB_TEST_MONGO_URI ?? '');
  const models = registerKnowledgeModels(connection);
  await models.KnowledgeModelBinding.create({
    workspaceId,
    knowledgeSpaceId: new connection.base.Types.ObjectId(spaceId),
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    modelType: 'embedding',
    modelId: 'mock-embedding-768',
    displayName: 'Mock embedding 768',
    requiredCapabilities: ['text-embedding', 'dimension:768'],
    status: 'active',
    activeQueryModelId: 'mock-embedding-768',
    activeQueryDimension: 768,
    authorizedAt: new Date(),
  });
  await seedSynonyms();
  browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
  await app?.close();
});

describe('TEST-X-FRONTEND-A11Y S9 real Synonyms page', () => {
  it('passes responsive, axe, navigation, operation and overflow gates', async () => {
    const cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
    for (const viewport of [
      { name: 'mobile', width: 360, height: 900 },
      { name: 'tablet', width: 768, height: 1000 },
      { name: 'desktop', width: 1200, height: 1000 },
    ]) {
      const browserContext = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      await browserContext.addCookies([cookie]);
      const page = await browserContext.newPage();
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(`${app.baseUrl}/spaces/${spaceId}/synonyms`, {
        waitUntil: 'networkidle',
      });
      await playwrightExpect(page.getByRole('heading', { level: 1, name: '同义词' })).toBeVisible();
      await playwrightExpect(page.getByText('退款', { exact: true })).toBeVisible();
      await playwrightExpect(page.getByText('退货', { exact: true })).toBeVisible();
      for (const href of [
        `/spaces/${spaceId}/images`,
        `/spaces/${spaceId}/search`,
        `/spaces/${spaceId}/synonyms`,
      ]) {
        await playwrightExpect(page.locator(`a[href="${href}"]`).first()).toBeVisible();
      }
      for (const name of ['更新版本', '下载 CSV', '停用', '重建索引', '删除', '搜索']) {
        await playwrightExpect(
          page.getByRole('button', { name, exact: true }).first(),
        ).toBeVisible();
      }
      await playwrightExpect(page.getByLabel('选择 CSV、XLS 或 XLSX')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${viewport.name} horizontal overflow`).toBeLessThanOrEqual(0);
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(
        accessibility.violations.filter(
          (violation) => violation.impact === 'serious' || violation.impact === 'critical',
        ),
      ).toEqual([]);
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement !== null)).toBe(true);
      const screenshot = await page.screenshot({
        fullPage: true,
        path: join(outputDir, `${viewport.name}.png`),
      });
      writeFileSync(
        join(outputDir, `${viewport.name}.sha256`),
        `${createHash('sha256').update(screenshot).digest('hex')}\n`,
      );
      await browserContext.close();
    }
    const progressContext = await browser.newContext({
      viewport: { width: 1200, height: 900 },
    });
    await progressContext.addCookies([cookie]);
    const progressPage = await progressContext.newPage();
    const progressRequests: string[] = [];
    const progressErrors: string[] = [];
    progressPage.on('request', (request) => {
      progressRequests.push(`${request.method()} ${request.url()}`);
    });
    progressPage.on('console', (message) => {
      if (message.type() === 'error') progressErrors.push(message.text());
    });
    progressPage.on('pageerror', (error) => progressErrors.push(error.message));
    await progressPage.goto(`${app.baseUrl}/spaces/${spaceId}/synonyms`, {
      waitUntil: 'networkidle',
    });
    const rebuildButton = progressPage.getByRole('button', {
      name: '重建索引',
      exact: true,
    });
    await playwrightExpect(rebuildButton).toBeEnabled();
    const rebuildResponse = progressPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith(`/spaces/${spaceId}/synonyms/rebuild`) &&
        response.request().method() === 'POST',
      { timeout: 5_000 },
    );
    await rebuildButton.click();
    await playwrightExpect(
      (
        await rebuildResponse.catch((error) => {
          throw new Error(
            `${String(error)}\nrequests=${JSON.stringify(progressRequests)}\nerrors=${JSON.stringify(progressErrors)}`,
          );
        })
      ).status(),
    ).toBe(202);
    await playwrightExpect(progressPage.getByText('重建进度', { exact: true })).toBeVisible();
    await progressContext.close();
  }, 120_000);
});
