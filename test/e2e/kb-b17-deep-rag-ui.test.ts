import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startB12ImageDeepHarness, type B12ImageDeepHarness } from './b12-image-deep-harness';
import { consoleCookie } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const evidenceDirectory =
  process.env.S11_UI_EVIDENCE_DIR?.trim() || join(root, 'test-results/b17/b17-20261121-152033/e2e');

let fixture: B12ImageDeepHarness;
let authToken = '';
let workspaceId = '';
let spaceId = '';

async function openSearchTest(page: Page) {
  const cookie = await consoleCookie({
    baseUrl: fixture.app.baseUrl,
    authToken,
    workspaceId,
  });
  await page.context().addCookies([cookie]);
  await page.goto(`${fixture.app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=test`, {
    waitUntil: 'networkidle',
  });
  await playwrightExpect(page.getByRole('heading', { level: 2, name: '搜索测试' })).toBeVisible();
}

function deepModeControl(page: Page) {
  return page.getByRole('radio', { name: /Deep RAG|深度检索|深度搜索/ });
}

async function selectDeepMode(page: Page) {
  const control = deepModeControl(page);
  await playwrightExpect(
    control,
    'the real Search Test page must expose Deep mode without a separate page',
  ).toBeVisible({ timeout: 5_000 });
  await control.check();
}

async function capture(page: Page, name: string) {
  mkdirSync(evidenceDirectory, { recursive: true });
  const screenshot = await page.screenshot({
    path: join(evidenceDirectory, `${name}.png`),
    fullPage: true,
  });
  writeFileSync(
    join(evidenceDirectory, `${name}.sha256`),
    `${createHash('sha256').update(screenshot).digest('hex')}\n`,
  );
}

beforeAll(async () => {
  fixture = await startB12ImageDeepHarness({ pricingProfile: 'fixture-v1' });
  authToken = fixture.authToken;
  workspaceId = fixture.workspaceId;
  spaceId = fixture.spaceId;
}, 240_000);

afterAll(async () => {
  await fixture?.close();
});

describe('L1-B17-SEARCH-008 real product Search Test UI', () => {
  it('L1-B17-SEARCH-008-UI01 exposes an accessible Deep mode in the existing Search Test page', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
      });
      const page = await context.newPage();
      await openSearchTest(page);
      await capture(page, 'b17-deep-ui01-search-test');
      const deepControl = deepModeControl(page);
      await playwrightExpect(
        deepControl,
        'the real Search Test page must expose Deep mode without a separate page',
      ).toBeVisible();
      await deepControl.focus();
      await page.keyboard.press('Space');
      await playwrightExpect(deepControl).toBeChecked();
      await context.close();
    } finally {
      await browser.close();
    }
  }, 180_000);

  it('L1-B17-SEARCH-008-UI02 exposes bounded Deep parameters and AI Points budget', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
      });
      const page = await context.newPage();
      await openSearchTest(page);
      await selectDeepMode(page);
      await page.getByRole('button', { name: '参数' }).click();
      for (const name of [
        /最大轮次/,
        /单轮.*token/i,
        /总.*token/i,
        /AI Points.*预算/,
        /无新证据.*停止/,
      ]) {
        await playwrightExpect(page.getByLabel(name)).toBeVisible();
      }
      await playwrightExpect(page.getByLabel(/最大轮次/)).toHaveValue('3');
      await playwrightExpect(page.getByLabel(/单轮.*token/i)).toHaveValue('5000');
      await playwrightExpect(page.getByLabel(/总.*token/i)).toHaveValue('12000');
      await page.getByLabel(/最大轮次/).fill('2');
      await page.getByRole('button', { name: '取消' }).click();
      await page.getByRole('button', { name: '参数' }).click();
      await playwrightExpect(page.getByLabel(/最大轮次/)).toHaveValue('3');
      await page.getByLabel(/最大轮次/).fill('4');
      await page.getByRole('button', { name: '完成' }).click();
      await playwrightExpect(
        page.getByRole('alert').filter({ hasText: /最大轮次.*1.*3/ }),
      ).toBeVisible();
      await playwrightExpect(page.getByLabel(/最大轮次/)).toHaveValue('4');
      await playwrightExpect(page.getByRole('dialog')).toBeVisible();
      await capture(page, 'b17-deep-ui02-parameters');
      await context.close();
    } finally {
      await browser.close();
    }
  }, 180_000);

  it('L1-B17-SEARCH-008-UI03 keeps the query and blocks duplicate billing submissions while loading', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
      });
      const page = await context.newPage();
      await openSearchTest(page);
      await selectDeepMode(page);
      await page.getByLabel('测试查询').fill('Compare refund escalation ownership');
      let deepRequests = 0;
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/v1/knowledge/search/deep') deepRequests += 1;
      });
      await page.route('**/v1/knowledge/search/deep', async (route) => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
        await route.continue();
      });
      await page.getByRole('button', { name: /开始测试|运行.*Deep|深度检索/ }).click();
      await page.keyboard.press('Enter');
      await playwrightExpect(
        page.getByRole('button', { name: /运行中|测试中|busy/i }),
      ).toBeDisabled();
      await playwrightExpect(page.getByLabel('测试查询')).toHaveValue(
        'Compare refund escalation ownership',
      );
      expect(deepRequests).toBe(1);
      await context.close();
    } finally {
      await browser.close();
    }
  }, 180_000);

  it('L1-B17-SEARCH-008-UI04 renders stop reason, rounds, token and AI Points usage and citations', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
      });
      const page = await context.newPage();
      await openSearchTest(page);
      await selectDeepMode(page);
      await page.getByLabel('测试查询').fill('Compare refund and escalation policies');
      const firstDeepResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/v1/knowledge/search/deep',
      );
      await page.getByRole('button', { name: /开始测试|运行.*Deep|深度检索/ }).click();
      const firstPayload = (await (await firstDeepResponse).json()) as {
        data: Record<string, unknown>;
      };
      await playwrightExpect(page.getByText(/停止原因|stopReason/i)).toBeVisible();
      await playwrightExpect(page.getByText('轮次', { exact: true })).toBeVisible();
      await playwrightExpect(page.getByText('AI Points', { exact: true }).first()).toBeVisible();
      await playwrightExpect(page.getByText('Token', { exact: true }).first()).toBeVisible();
      await playwrightExpect(
        page.getByText(/How long does a refund take|S8 refund|Refund policy/).first(),
      ).toBeVisible();
      await capture(page, 'b17-deep-ui04-results');
      await page.route('**/v1/knowledge/search/deep', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              searchId: 'search_b17_empty',
              mode: 'multi_space',
              items: [],
              partial: false,
              durationMs: 12,
              degraded: [],
              rerankApplied: false,
              rounds: [
                {
                  round: 1,
                  queries: ['no matching policy'],
                  candidateCount: 0,
                  sufficient: false,
                  inputTokens: 20,
                  outputTokens: 4,
                  aiPoints: 0.002,
                  permissionRevision: 0,
                },
              ],
              stopReason: 'no_new_evidence',
              usage: {
                inputTokens: 20,
                outputTokens: 4,
                aiPoints: 0.002,
                aiPointsMicros: 2_000,
                costBudgetPoints: 1,
                remainingAiPoints: 0.998,
              },
            },
            traceId: 'trace-b17-empty',
            requestId: 'req-b17-empty',
          }),
        });
      });
      await page.getByLabel('测试查询').fill('no matching policy');
      await page.getByRole('button', { name: '开始测试' }).click();
      await playwrightExpect(page.getByText(/搜索结果为空/)).toBeVisible();
      await playwrightExpect(
        page.getByText(/How long does a refund take|S8 refund|Refund policy/).first(),
      ).toBeVisible();
      await page.unroute('**/v1/knowledge/search/deep');
      await page.route('**/v1/knowledge/search/deep', async (route) => {
        await route.fulfill({
          status: 207,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              ...firstPayload.data,
              partial: true,
              degraded: ['KNOWLEDGE_PARTIAL_SUCCESS'],
              stopReason: 'dependency_failure',
            },
            traceId: 'trace-b17-partial',
            requestId: 'req-b17-partial',
          }),
        });
      });
      await page.getByLabel('测试查询').fill('Compare refund after dependency failure');
      await page.getByRole('button', { name: '开始测试' }).click();
      await playwrightExpect(page.getByText(/部分结果/)).toBeVisible();
      await context.close();
    } finally {
      await browser.close();
    }
  }, 180_000);

  it('L1-B17-SEARCH-008-UI05 isolates restored Deep history and drops expired sensitive previews', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
      });
      const page = await context.newPage();
      await openSearchTest(page);
      await page.evaluate((datasetId) => {
        localStorage.setItem(
          `kb-product-search-history:${datasetId}`,
          JSON.stringify([
            {
              id: 'corrupt',
              query: 'old',
              imageLabel: null,
              createdAt: new Date().toISOString(),
              result: {
                searchId: 'search_corrupt',
                mode: 'deep',
                items: [],
                rounds: [],
                stopReason: 'sufficient',
                usage: {},
                partial: false,
                durationMs: 1,
              },
              settings: {},
              expiredPreview: 'https://invalid.example/content?ticket=secret',
            },
          ]),
        );
      }, spaceId);
      await page.reload({ waitUntil: 'networkidle' });
      await playwrightExpect(page.getByRole('heading', { name: '测试历史' })).toBeVisible();
      await playwrightExpect(deepModeControl(page)).toBeVisible();
      const storage = await page.evaluate(() => JSON.stringify(localStorage));
      expect(storage).not.toContain('ticket=secret');
      await context.close();
    } finally {
      await browser.close();
    }
  }, 180_000);

  it('L1-B17-SEARCH-008-UI06 has no serious axe violations, overflow or browser errors at 360/768/1440', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const viewport of [
        { name: '360', width: 360, height: 900 },
        { name: '768', width: 768, height: 1_000 },
        { name: '1440', width: 1_440, height: 900 },
      ]) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          locale: 'zh-CN',
        });
        const page = await context.newPage();
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const failedRequests: string[] = [];
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(`${viewport.name}:${message.text()}`);
        });
        page.on('pageerror', (error) => pageErrors.push(`${viewport.name}:${error.message}`));
        page.on('requestfailed', (request) =>
          failedRequests.push(`${viewport.name}:${request.url()}`),
        );
        await openSearchTest(page);
        await selectDeepMode(page);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${viewport.name} horizontal overflow`).toBeLessThanOrEqual(1);
        const accessibility = await new AxeBuilder({ page }).analyze();
        expect(
          accessibility.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          ),
          `${viewport.name} serious axe violations`,
        ).toEqual([]);
        expect(consoleErrors).toEqual([]);
        expect(pageErrors).toEqual([]);
        expect(failedRequests).toEqual([]);
        await capture(page, `b17-deep-ui06-accessibility-${viewport.name}`);
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }, 180_000);

  it('L1-B17-SEARCH-008-UI07 calls the real Deep route from the product page and renders its stop contract', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
      });
      const page = await context.newPage();
      await openSearchTest(page);
      await selectDeepMode(page);
      await page.getByLabel('测试查询').fill('Compare refund policies');
      const deepResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/v1/knowledge/search/deep',
      );
      await page.getByRole('button', { name: /开始测试|运行.*Deep|深度检索/ }).click();
      const response = await deepResponse;
      expect([200, 207]).toContain(response.status());
      const payload = (await response.json()) as {
        data: {
          stopReason: string;
          rounds: unknown[];
          usage: { inputTokens: number; outputTokens: number };
          items: unknown[];
        };
      };
      expect(payload.data.rounds.length).toBeGreaterThan(0);
      expect(payload.data.usage.inputTokens).toBeGreaterThanOrEqual(0);
      await playwrightExpect(page.getByText(payload.data.stopReason)).toBeVisible();
      await context.close();
    } finally {
      await browser.close();
    }
  }, 240_000);
});
