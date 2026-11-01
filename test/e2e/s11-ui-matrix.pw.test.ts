import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from '@playwright/test';
import {
  assertAuthorizedNavigation,
  assertAxe,
  assertBrowserErrors,
  assertFocusable,
  assertNoOverflow,
  assertShell,
  assertSkipLink,
  collectBrowserErrors,
} from './s11-a11y-helpers';
import {
  S11_CANONICAL_PAGES,
  S11_VIEWPORTS,
  bootstrapUiSession,
  canonicalPageTarget,
  createUiWorkspace,
  deleteUiWorkspace,
  startUiMatrix,
  uiScreenshotName,
  type UiMatrixConfiguration,
  type UiMatrixSession,
  type UiMatrixWorkspace,
} from './s11-ui-matrix.fixture';

let configuration: UiMatrixConfiguration;
let api: APIRequestContext;
let session: UiMatrixSession;
let workspace: UiMatrixWorkspace;

function runtimeApiPath(url: string): string | null {
  const pathname = new URL(url).pathname;
  if (pathname === '/api/console/session') return pathname;
  if (pathname.startsWith('/v1/')) return pathname;
  if (pathname.startsWith('/api/')) return pathname;
  return null;
}

function isAllowedRuntimePath(pathname: string): boolean {
  return pathname === '/api/console/session' || pathname.startsWith('/v1/knowledge/');
}

test.beforeAll(async () => {
  configuration = startUiMatrix();
  api = await playwrightRequest.newContext({
    baseURL: configuration.baseUrl,
    ignoreHTTPSErrors: false,
  });
  session = await bootstrapUiSession(api, configuration);
  workspace = await createUiWorkspace(api, configuration, session);
});

test.afterAll(async () => {
  try {
    if (api && configuration && session && workspace) {
      await deleteUiWorkspace(api, configuration, session, workspace);
    }
  } finally {
    await api?.dispose();
  }
});

test('TEST-X-S11-UI-MATRIX renders 18 pages at three viewports with external evidence', async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const results: Array<{
    pageId: string;
    route: string;
    viewport: string;
    width: number;
    height: number;
    status: 'PASS';
    screenshot: string;
    sha256: string;
    overflow: number;
    axe: { serious: number; critical: number; violations: number };
    runtimeRequests: string[];
  }> = [];

  for (const viewport of S11_VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      storageState: session.storageState,
      locale: 'zh-CN',
      colorScheme: 'light',
    });
    context.setDefaultTimeout(30_000);
    try {
      for (const pageDefinition of S11_CANONICAL_PAGES) {
        const page = await context.newPage();
        const browserErrors = collectBrowserErrors(page);
        const runtimeRequests = new Set<string>();
        const runtimeFailures: string[] = [];
        page.on('request', (request) => {
          const pathname = runtimeApiPath(request.url());
          if (pathname) runtimeRequests.add(`${request.method()} ${pathname}`);
        });
        page.on('response', (response) => {
          const pathname = runtimeApiPath(response.url());
          if (pathname && response.status() >= 400) {
            runtimeFailures.push(
              `${response.request().method()} ${pathname} status=${response.status()}`,
            );
          }
        });
        try {
          const target = canonicalPageTarget(pageDefinition, workspace);
          const response = await page.goto(`${configuration.baseUrl}${target}`, {
            waitUntil: 'networkidle',
          });
          expect(response?.ok(), `${pageDefinition.id} navigation status`).toBe(true);
          await assertShell(page);
          const overflow = await assertNoOverflow(page);
          const axe = await assertAxe(page);
          await assertAuthorizedNavigation(page, true);
          assertBrowserErrors(browserErrors);
          expect(runtimeFailures, `${pageDefinition.id} runtime API failures`).toEqual([]);
          expect(
            [...runtimeRequests].filter((request) => !isAllowedRuntimePath(request.split(' ')[1]!)),
            `${pageDefinition.id} runtime request allowlist`,
          ).toEqual([]);
          expect(
            [...runtimeRequests].filter(
              (request) =>
                request.includes('501999') ||
                request.includes('/api/v1/knowledge') ||
                request.includes('/api/knowledge'),
            ),
            `${pageDefinition.id} legacy API requests`,
          ).toEqual([]);

          const screenshotName = uiScreenshotName(pageDefinition.id, viewport.name);
          const screenshotPath = join(configuration.evidenceDirectory, screenshotName);
          const screenshot = await page.screenshot({ fullPage: true });
          writeFileSync(screenshotPath, screenshot);
          const sha256 = createHash('sha256').update(screenshot).digest('hex');
          writeFileSync(`${screenshotPath}.sha256`, `${sha256}\n`);

          await assertFocusable(page);
          await assertSkipLink(page);
          assertBrowserErrors(browserErrors);
          expect(runtimeFailures, `${pageDefinition.id} runtime API failures after a11y`).toEqual(
            [],
          );
          results.push({
            pageId: pageDefinition.id,
            route: pageDefinition.route,
            viewport: viewport.name,
            width: viewport.width,
            height: viewport.height,
            status: 'PASS',
            screenshot: screenshotName,
            sha256,
            overflow,
            axe,
            runtimeRequests: [...runtimeRequests].sort(),
          });
        } catch (error) {
          throw new Error(`${pageDefinition.id} at ${viewport.name}: ${String(error)}`, {
            cause: error,
          });
        } finally {
          await page.close();
        }
      }
    } finally {
      await context.close();
    }
  }

  expect(results).toHaveLength(54);
  expect(new Set(results.map((entry) => `${entry.pageId}:${entry.viewport}`)).size).toBe(54);
  for (const result of results) {
    expect(
      existsSync(join(configuration.evidenceDirectory, result.screenshot)),
      `${result.screenshot} exists`,
    ).toBe(true);
    expect(
      existsSync(join(configuration.evidenceDirectory, `${result.screenshot}.sha256`)),
      `${result.screenshot}.sha256 exists`,
    ).toBe(true);
  }
  writeFileSync(
    join(configuration.evidenceDirectory, 'ui-summary.json'),
    `${JSON.stringify(
      {
        testId: 'TEST-X-S11-UI-MATRIX',
        status: 'PASS',
        generatedAt: new Date().toISOString(),
        baseHost: new URL(configuration.baseUrl).host,
        pages: S11_CANONICAL_PAGES.length,
        viewports: S11_VIEWPORTS,
        results,
      },
      null,
      2,
    )}\n`,
  );
});
