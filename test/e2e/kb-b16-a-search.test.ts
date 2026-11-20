import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const runId = `b16-a-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const evidenceDir = join(root, 'test-results', 'b16', 'a', runId, 'ui');
let browser: Browser;
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  const bundlePath = join(mkdtempSync(join(tmpdir(), 'kb-b16-a-ui-')), 'bundle.js');
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
  const bundle = await import('node:fs/promises').then(({ readFile }) =>
    readFile(bundlePath, 'utf8'),
  );
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>B16 Search Harness</title><style>html,body,#root{min-height:100%}body{margin:0}#root{padding:24px}</style></head>
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
});

describe('B16 codexA desktop search page', () => {
  it('L1-B16-A-SEARCH-001-UI01 exposes 1440x900 mode, parameters, result and no duplicate submit', async () => {
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
    await page.goto(`${baseUrl}/?state=idle`, { waitUntil: 'networkidle' });
    const query = page.getByLabel('Query');
    const submit = page.getByRole('button', { name: 'Run search' });
    await query.fill('');
    await playwrightExpect(submit).toBeDisabled();
    await query.fill('退款需要多久？');
    await playwrightExpect(submit).toBeEnabled();
    await page.getByRole('button', { name: 'Semantic' }).click();
    await submit.click();
    await playwrightExpect(page.getByText('Support playbook')).toBeVisible({ timeout: 5_000 });
    await playwrightExpect(page.getByText(/42 ms/)).toBeVisible();
    await playwrightExpect(page.getByText(/Results\s*1/)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const accessibility = await new AxeBuilder({ page }).analyze();
    const screenshot = await page.screenshot({
      fullPage: true,
      path: join(evidenceDir, 'search-1440x900.png'),
    });
    writeFileSync(
      join(evidenceDir, 'search-1440x900.sha256'),
      `${createHash('sha256').update(screenshot).digest('hex')}\n`,
    );
    writeFileSync(
      join(evidenceDir, 'axe.json'),
      `${JSON.stringify(accessibility.violations, null, 2)}\n`,
    );
    expect(
      accessibility.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      ),
    ).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    await context.close();
  }, 120_000);

  it('L1-B16-A-SEARCH-002-UI02 distinguishes partial and empty states', async () => {
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
    await context.close();
  }, 120_000);
});
