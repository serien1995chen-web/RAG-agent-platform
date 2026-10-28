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
const outputDir = join(
  root,
  'test-results',
  `s09-synonyms-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
let browser: Browser;
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  mkdirSync(outputDir, { recursive: true });
  const bundlePath = join(mkdtempSync(join(tmpdir(), 'kb-s9-ui-')), 'bundle.js');
  await build({
    entryPoints: [join(root, 'test/e2e/s9-synonyms-ui.fixture.tsx')],
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
    <title>S9 Synonyms Harness</title>
    <style>html, body, #root { min-height: 100%; } body { margin: 0; } #root { padding: 24px; }</style>
  </head>
  <body>
    <div id="root"></div>
    <script>${bundle.replaceAll('</script>', '<\\/script>')}</script>
  </body>
</html>`;
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

describe('TEST-X-FRONTEND-A11Y S9 test-only Synonyms UI', () => {
  it('passes 360/768/1200 overflow, axe, keyboard and operation controls', async () => {
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
      await page.goto(`${baseUrl}/?state=ready`, { waitUntil: 'networkidle' });
      await playwrightExpect(
        page.getByRole('heading', { level: 1, name: 'Synonyms' }),
      ).toBeVisible();
      await playwrightExpect(page.getByText('reimbursement')).toBeVisible();
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

      await page.getByLabel('Choose CSV, XLS, or XLSX').setInputFiles({
        name: 'synonyms.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('标准词,同义词\nRefund,reimbursement\n'),
      });
      const updateButton = page.getByRole('button', { name: 'Update version' });
      await playwrightExpect(updateButton).toBeEnabled();
      await updateButton.click();
      await playwrightExpect(page.getByRole('heading', { name: 'Mappings' })).toBeVisible();
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement !== null)).toBe(true);
      await browserContext.close();
    }

    const errorContext = await browser.newContext({ viewport: { width: 768, height: 900 } });
    const page = await errorContext.newPage();
    await page.goto(`${baseUrl}/?state=invalid`, { waitUntil: 'networkidle' });
    await playwrightExpect(page.getByText('File validation failed')).toBeVisible();
    await playwrightExpect(page.getByText(/Row 5/)).toBeVisible();
    await page.goto(`${baseUrl}/?state=conflict`, { waitUntil: 'networkidle' });
    await playwrightExpect(page.getByText(/KNOWLEDGE_CONFLICT/)).toBeVisible();
    await page.goto(`${baseUrl}/?state=rate_limited`, { waitUntil: 'networkidle' });
    await playwrightExpect(page.getByText(/KNOWLEDGE_RATE_LIMITED/)).toBeVisible();
    await page.goto(`${baseUrl}/?state=payload_too_large`, { waitUntil: 'networkidle' });
    await playwrightExpect(page.getByText('The file exceeds 10 MiB.')).toBeVisible();
    await errorContext.close();
  }, 120_000);
});
