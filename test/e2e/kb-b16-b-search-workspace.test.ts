import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const evidenceDirectory =
  process.env.B16_UI_EVIDENCE_DIR?.trim() || resolve(root, 'test-results/b16/b/20261120-223600/ui');
let browser: Browser;
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  mkdirSync(evidenceDirectory, { recursive: true });
  const bundlePath = join(mkdtempSync(join(tmpdir(), 'kb-b16-b-ui-')), 'bundle.js');
  await build({
    entryPoints: [join(root, 'test/e2e/kb-b16-b-search-workspace.fixture.tsx')],
    outfile: bundlePath,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    nodePaths: [
      resolve(root, 'projects/app/node_modules'),
      resolve(root, 'packages/web/node_modules'),
      resolve(root, 'node_modules'),
    ],
    minify: false,
    sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const bundle = await import('node:fs/promises').then(({ readFile }) =>
    readFile(bundlePath, 'utf8'),
  );
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>B16 Search Workspace</title>
    <style>html,body,#root{min-height:100%}body{margin:0}#root{padding:24px}</style>
    </head><body><div id="root"></div><script>${bundle.replaceAll(
      '</script>',
      '<\\/script>',
    )}</script></body></html>`;
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        baseUrl = `http://127.0.0.1:${address.port}`;
      }
      ready();
    });
  });
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((closed) => server?.close(() => closed()));
});

describe('L1-B16-B-SEARCH-005-UI01 product Search Test history and result state', () => {
  it('caps history at 50 and restores it after refresh', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    await playwrightExpect(page.getByRole('heading', { name: '搜索测试' })).toBeVisible();
    await playwrightExpect(page.locator('.kb2-search-history')).toHaveCount(50);

    await page.reload({ waitUntil: 'networkidle' });
    await playwrightExpect(page.locator('.kb2-search-history')).toHaveCount(50);
    await context.close();
  }, 120_000);

  it('explains the query-optimization model constraint in settings', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: '参数' }).click();
    await page.getByRole('checkbox', { name: '启用问题优化' }).check();
    const noModelSelect = page.locator('select').filter({ hasText: '没有可用的文本模型' });
    await playwrightExpect(noModelSelect).toBeDisabled();
    await context.close();
  }, 120_000);

  it('keeps the previous result on empty response and renders image result thumbnails', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    await page.getByLabel('测试查询').fill('refund');
    await page.getByRole('button', { name: '开始测试' }).click();
    await playwrightExpect(page.getByText('Where is the refund policy?')).toBeVisible();

    await page.getByLabel('测试查询').fill('empty');
    await page.getByRole('button', { name: '开始测试' }).click();
    await playwrightExpect(
      page.getByText('搜索结果为空。右侧继续保留上一条测试结果。'),
    ).toBeVisible();
    await playwrightExpect(page.getByText('Where is the refund policy?')).toBeVisible();

    await page.getByLabel('测试查询').fill('empty-degraded');
    await page.getByRole('button', { name: '开始测试' }).click();
    await playwrightExpect(
      page.getByText('降级原因：image_preview_unavailable。', { exact: false }),
    ).toBeVisible();
    await playwrightExpect(page.getByText('Where is the refund policy?')).toBeVisible();

    await page.getByLabel('测试查询').fill('image');
    await page.getByRole('button', { name: '开始测试' }).click();
    await page.screenshot({
      path: join(evidenceDirectory, 'search-image-result-1440x900.png'),
      fullPage: true,
    });
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
    await playwrightExpect(page.getByRole('img', { name: 'Refund chart' })).toBeVisible();
    const storedHistory = await page.evaluate(() =>
      globalThis.localStorage.getItem('kb-product-search-history:65f1e5b2a1c9d4b7e8f09600'),
    );
    expect(storedHistory).not.toContain('ticket=redacted');
    expect(storedHistory).not.toContain('data:image/svg');

    await page.getByLabel('测试查询').fill('image-expired');
    await page.getByRole('button', { name: '开始测试' }).click();
    await playwrightExpect(page.getByText('图片预览已过期或不可用，请重新测试。')).toBeVisible();
    await context.close();
  }, 120_000);
});
