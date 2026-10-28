import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const screenshotDir = join(root, 'docs/acceptance/s8-ui');
let browser: Browser;
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  mkdirSync(screenshotDir, { recursive: true });
  const bundlePath = join(mkdtempSync(join(tmpdir(), 'kb-s8-ui-')), 'bundle.js');
  await build({
    entryPoints: [join(root, 'test/e2e/s8-images-deep.fixture.tsx')],
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
    loader: { '.css': 'css' },
    minify: false,
    sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const bundle = readFileSync(bundlePath, 'utf8');
  const cssPath = bundlePath.replace(/\.js$/, '.css');
  const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>S8 Images Deep Harness</title><style>html,body,#root{min-height:100%}body{margin:0}#root{padding:24px}${css}</style></head>
<body><div id="root"></div><script>${bundle.replaceAll('</script>', '<\\/script>')}</script></body></html>`;
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') baseUrl = `http://127.0.0.1:${address.port}`;
      ready();
    });
  });
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((closed) => server?.close(() => closed()));
});

describe('TEST-X-FRONTEND-A11Y S8 Images and Deep UI', () => {
  it('passes three viewports, axe, overflow, console and network checks', async () => {
    for (const panel of ['images', 'deep'] as const) {
      for (const viewport of [
        { name: '360', width: 360, height: 900 },
        { name: '768', width: 768, height: 1_000 },
        { name: '1200', width: 1_200, height: 1_000 },
      ]) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        const page = await context.newPage();
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const failedRequests: string[] = [];
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text());
        });
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('requestfailed', (request) => failedRequests.push(request.url()));
        await page.goto(`${baseUrl}/?panel=${panel}`, { waitUntil: 'networkidle' });
        await playwrightExpect(
          page.getByRole('heading', {
            level: 1,
            name: panel === 'images' ? 'Image knowledge' : 'Deep search',
          }),
        ).toBeVisible();
        if (panel === 'images') {
          await playwrightExpect(
            page.getByText('Refund flow', { exact: false }).first(),
          ).toBeVisible();
          await page.getByRole('button', { name: 'Preview' }).first().click();
          await playwrightExpect(page.getByRole('dialog')).toBeVisible();
          await page.keyboard.press('Escape');
          await playwrightExpect(page.getByRole('dialog')).toHaveCount(0, { timeout: 5_000 });
          await page.getByPlaceholder('Describe the image').fill('refund');
          await page.getByRole('checkbox', { name: 'Refund flow' }).check({ force: true });
          await page.getByRole('button', { name: 'Search images' }).click();
          await playwrightExpect(page.getByText('Support policy')).toBeVisible();
        } else {
          await playwrightExpect(page.getByText('dependency_failure')).toBeVisible();
          await playwrightExpect(page.getByText('2000 / 300')).toBeVisible();
        }
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${panel}-${viewport.name} overflow`).toBeLessThanOrEqual(0);
        const accessibility = await new AxeBuilder({ page }).analyze();
        expect(
          accessibility.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          ),
        ).toEqual([]);
        expect(consoleErrors).toEqual([]);
        expect(pageErrors).toEqual([]);
        expect(failedRequests).toEqual([]);
        const screenshot = await page.screenshot({
          fullPage: true,
          path: join(screenshotDir, `s8-${panel}-${viewport.name}.png`),
        });
        writeFileSync(
          join(screenshotDir, `s8-${panel}-${viewport.name}.sha256`),
          `${createHash('sha256').update(screenshot).digest('hex')}\n`,
        );
        await context.close();
      }
    }
  }, 180_000);
});
