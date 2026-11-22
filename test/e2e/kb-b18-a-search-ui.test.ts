import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const evidenceDir = process.env.B18_EVIDENCE_DIR ?? resolve(root, 'test-results', 'b18-a', 'ui');
let browser: Browser;
let server: Server;
let baseUrl = '';
let bundleDir = '';

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  bundleDir = mkdtempSync(join(tmpdir(), 'kb-b18-a-ui-'));
  const bundlePath = join(bundleDir, 'bundle.js');
  await build({
    entryPoints: [join(root, 'test/e2e/s7-search-ui.fixture.tsx')],
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
  const bundle = readFileSync(bundlePath, 'utf8');
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>B18 Search Harness</title><style>html,body,#root{min-height:100%}body{margin:0}#root{padding:24px}</style></head>
<body><div id="root"></div><script>${bundle.replaceAll('</script>', '<\\/script>')}</script></body></html>`;
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((resolveReady) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        baseUrl = `http://127.0.0.1:${address.port}`;
      }
      resolveReady();
    });
  });
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolveClosed) => server?.close(() => resolveClosed()));
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
});

describe('B18-A desktop Multi-Space and Citation UI', () => {
  it('L1-B18-SEARCH-007-UI01 selects multiple Spaces and exposes provenance plus score', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${baseUrl}/?state=ready`, { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Multiple spaces' }).click();
    const spaces = page.getByLabel('Knowledge spaces');
    await spaces.selectOption(['65f1e5b2a1c9d4b7e8f01234', '65f1e5b2a1c9d4b7e8f01235']);
    await playwrightExpect(spaces.locator('option:checked')).toHaveCount(2);
    await playwrightExpect(page.getByText('Support playbook')).toBeVisible();

    const screenshot = await page.screenshot({
      path: join(evidenceDir, 'multi-space-citation-1440x900.png'),
      fullPage: true,
    });
    writeFileSync(
      join(evidenceDir, 'multi-space-citation-1440x900.sha256'),
      `${createHash('sha256').update(screenshot).digest('hex')}\n`,
    );
    const accessibility = await new AxeBuilder({ page }).analyze();
    writeFileSync(
      join(evidenceDir, 'multi-space-citation-axe.json'),
      `${JSON.stringify(accessibility.violations, null, 2)}\n`,
    );

    const citationCard = page.locator('article.s7-citation').first();
    await playwrightExpect
      .soft(citationCard.getByText('Knowledge space 65f1e5b2a1c9d4b7e8f01234'))
      .toBeVisible();
    await playwrightExpect.soft(citationCard.getByText('Score 0.8700')).toBeVisible();
    expect(
      accessibility.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);

    await page.reload({ waitUntil: 'networkidle' });
    await playwrightExpect(page.getByText('Support playbook')).toBeVisible();
    await context.close();
  }, 120_000);

  it('L1-B18-SEARCH-007-UI01 distinguishes partial, empty and permission states', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/?state=partial`, { waitUntil: 'networkidle' });
    await playwrightExpect(
      page.getByText('Some retrieval channels were unavailable.'),
    ).toBeVisible();
    await playwrightExpect(page.getByText('fulltext_recall_failed')).toBeVisible();

    await page.goto(`${baseUrl}/?state=empty`, { waitUntil: 'networkidle' });
    await playwrightExpect(page.getByText('No matching knowledge was found.')).toBeVisible();

    await page.goto(`${baseUrl}/?state=permission`, { waitUntil: 'networkidle' });
    await playwrightExpect(page.getByText('Knowledge is not available.')).toBeVisible();
    await playwrightExpect(page.getByText('KNOWLEDGE_FORBIDDEN')).toBeVisible();
    await context.close();
  }, 120_000);

  it('L1-B18-SEARCH-007-UI02 has no blocking axe issue on the Multi-Space result state', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/?state=ready`, { waitUntil: 'networkidle' });
    await playwrightExpect(page.getByText('Support playbook')).toBeVisible();
    const accessibility = await new AxeBuilder({ page }).analyze();
    writeFileSync(
      join(evidenceDir, 'multi-space-result-axe.json'),
      `${JSON.stringify(accessibility.violations, null, 2)}\n`,
    );
    expect(
      accessibility.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
    await context.close();
  }, 120_000);

  it('L1-B18-SEARCH-009-UI01 requires Space and quote details in the Citation card', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/?state=ready`, { waitUntil: 'networkidle' });
    await playwrightExpect.soft(page.getByText('Citation', { exact: true })).toBeVisible();
    await playwrightExpect.soft(page.getByText(/65f1e5b2a1c9d4b7e8f01234/)).toBeVisible();
    await playwrightExpect.soft(page.getByText('Refunds are processed')).toBeVisible();
    await context.close();
  }, 120_000);

  it('L1-B18-SEARCH-009-Q01 renders Citation Markdown without executing injected HTML or URLs', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${baseUrl}/?state=ready&unsafe=1`, { waitUntil: 'networkidle' });
    await playwrightExpect(page.getByText('Support playbook')).toBeVisible();
    const citationHtml = await page.locator('article').innerHTML();
    writeFileSync(join(evidenceDir, 'citation-unsafe-markdown.html'), `${citationHtml}\n`);
    expect(citationHtml).not.toContain('onerror');
    expect(citationHtml).not.toContain('javascript:');
    expect(
      await page.evaluate(() => (globalThis as { __b18Xss?: number }).__b18Xss),
    ).toBeUndefined();
    expect(pageErrors).toEqual([]);
    await context.close();
  }, 120_000);
});
