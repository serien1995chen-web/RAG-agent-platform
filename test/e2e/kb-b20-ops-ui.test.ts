import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as uiExpect } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b20_ui_${suffix}`;
const memberId = `mem_b20_ui_${suffix}`;
const authToken = `b20-ui-token-${suffix}`;
const runId = process.env.B20_RUN_ID?.trim() || '20261123-190322';
const resultRoot = resolve(import.meta.dirname, '../..', 'test-results', 'b20', runId, 'ui');
let app: S4AppHarness;

beforeAll(async () => {
  app = await startS4App({
    suffix: `b20-${suffix}`,
    workspaceId,
    memberId,
    authToken,
    connectorMode: 'mock',
    pricingProfile: 'fixture-v1',
  });
}, 240_000);

afterAll(async () => {
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
      await page.waitForLoadState('networkidle');
      await uiExpect(
        page.getByRole('heading', { name: /用量|运营|Usage|Operations/i }).first(),
      ).toBeVisible();
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
      await uiExpect(
        page.getByRole('heading', { name: /用量|运营|Usage|Operations/i }).first(),
      ).toBeVisible();
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
});
