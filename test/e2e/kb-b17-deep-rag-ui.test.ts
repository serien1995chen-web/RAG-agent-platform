import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startB12ImageDeepHarness, type B12ImageDeepHarness } from './b12-image-deep-harness';
import { consoleCookie } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const evidenceDirectory =
  process.env.S11_UI_EVIDENCE_DIR?.trim() || join(root, 'test-results/b17/b17-parity');

let fixture: B12ImageDeepHarness;

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_b17_ui?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-local';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';
  fixture = await startB12ImageDeepHarness({ pricingProfile: 'fixture-v1' });
}, 240_000);

afterAll(async () => {
  await fixture?.close();
});

describe('FastGPT-aligned knowledge Search Test does not expose Deep RAG', () => {
  it('keeps Deep RAG in the API while removing every knowledge foreground entry', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
      });
      await context.addCookies([
        await consoleCookie({
          baseUrl: fixture.app.baseUrl,
          authToken: fixture.authToken,
          workspaceId: fixture.workspaceId,
        }),
      ]);
      const page = await context.newPage();
      await page.goto(
        `${fixture.app.baseUrl}/dataset/detail?datasetId=${fixture.spaceId}&currentTab=test`,
        { waitUntil: 'networkidle' },
      );
      await playwrightExpect(
        page.getByRole('heading', { level: 2, name: '输入测试内容' }),
      ).toBeVisible();
      await playwrightExpect(
        page.getByRole('radio', { name: /Deep RAG|深度检索|深度搜索/ }),
      ).toHaveCount(0);
      await playwrightExpect(page.getByText(/Deep RAG/)).toHaveCount(0);
      await page.getByRole('button', { name: '搜索配置' }).click();
      await playwrightExpect(page.getByRole('tab', { name: '搜索方式' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await playwrightExpect(page.getByRole('radio')).toHaveCount(3);
      await page.getByRole('button', { name: '关闭', exact: true }).click();

      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(
        accessibility.violations.filter(
          (violation) => violation.impact === 'serious' || violation.impact === 'critical',
        ),
      ).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);

      mkdirSync(evidenceDirectory, { recursive: true });
      const screenshot = await page.screenshot({
        path: join(evidenceDirectory, 'deep-rag-removed-from-knowledge-search.png'),
        fullPage: true,
      });
      writeFileSync(
        join(evidenceDirectory, 'deep-rag-removed-from-knowledge-search.sha256'),
        `${createHash('sha256').update(screenshot).digest('hex')}\n`,
      );
      await context.close();
    } finally {
      await browser.close();
    }
  }, 180_000);
});
