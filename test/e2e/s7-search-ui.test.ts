import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const outputDir = join(
  root,
  'test-results',
  `s7-search-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);

let browser: Browser;
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  mkdirSync(outputDir, { recursive: true });
  const bundlePath = join(mkdtempSync(join(tmpdir(), 'kb-s7-ui-')), 'bundle.js');
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
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>S7 Search Harness</title>
    <style>html, body, #root { min-height: 100%; } body { margin: 0; } #root { padding: 24px; }</style>
  </head>
  <body>
    <div id="root"></div>
    <script>${bundle.replaceAll('</script>', '<\\/script>')}</script>
  </body>
</html>`;
  server = createServer((request, response) => {
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

describe('TEST-X-FRONTEND-A11Y S7 test-only Search UI harness', () => {
  it('passes 360/768/1200 overflow, axe and state interaction checks', async () => {
    expect(baseUrl).not.toBe('');
    for (const viewport of [
      { name: 'mobile', width: 360, height: 900 },
      { name: 'tablet', width: 768, height: 1000 },
      { name: 'desktop', width: 1200, height: 1000 },
    ]) {
      const browserContext = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await browserContext.newPage();
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(`${baseUrl}/?state=partial`, { waitUntil: 'networkidle' });
      await playwrightExpect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
      await playwrightExpect(
        page.getByText('Some retrieval channels were unavailable.'),
      ).toBeVisible();
      await playwrightExpect(page.getByText('fulltext_recall_failed')).toBeVisible();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${viewport.name} horizontal overflow`).toBeLessThanOrEqual(0);

      const accessibility = await new AxeBuilder({ page }).analyze();
      const blocking = accessibility.violations.filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      );
      expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);

      const screenshot = await page.screenshot({
        fullPage: true,
        path: join(outputDir, `${viewport.name}.png`),
      });
      writeFileSync(
        join(outputDir, `${viewport.name}.sha256`),
        `${createHash('sha256').update(screenshot).digest('hex')}\n`,
      );

      await page.getByLabel('Query').fill('refund escalation');
      await page.getByRole('button', { name: 'Full text' }).click();
      await page.getByLabel('Token budget').fill('7000');
      await page.getByRole('button', { name: 'Run search' }).click();
      await playwrightExpect(page.getByText('Support playbook')).toBeVisible({
        timeout: 5_000,
      });
      await browserContext.close();
    }

    const finalContext = await browser.newContext({ viewport: { width: 768, height: 900 } });
    const page = await finalContext.newPage();
    await page.goto(`${baseUrl}/?state=empty`, { waitUntil: 'networkidle' });
    await playwrightExpect(page.getByText('No matching knowledge was found.')).toBeVisible();
    await page.goto(`${baseUrl}/?state=error`, { waitUntil: 'networkidle' });
    await playwrightExpect(page.getByText('KNOWLEDGE_INTERNAL_ERROR')).toBeVisible();
    await playwrightExpect(page.getByText('trace-fixture')).toBeVisible();
    await playwrightExpect(page.getByText('Support playbook')).toHaveCount(0);
    await finalContext.close();
  }, 120_000);
});
