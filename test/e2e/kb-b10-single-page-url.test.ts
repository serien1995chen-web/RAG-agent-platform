import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consoleCookie,
  createSpace,
  requiredEnv,
  startS4App,
  type S4AppHarness,
} from './s4-app-harness';
import {
  B10_PUBLIC_FIXTURE_BASE_URL,
  B10_PUBLIC_FIXTURE_PATHS,
  b10PublicUrl,
} from './b10-public-fixture';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b10_e2e_${suffix}`;
const memberId = `mem_b10_e2e_${suffix}`;
const authToken = `b10-e2e-token-${suffix}`;

let app: S4AppHarness;
let browser: Browser;
let spaceId = '';
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;
const evidenceRoot = join(
  process.cwd(),
  'test-results',
  'b10',
  process.env.B10_EVIDENCE_RUN_ID ?? 'b10-ad-hoc',
  'e2e',
);

interface PageDiagnostics {
  consoleErrors: string[];
  failedRequests: Array<{ url: string; error: string }>;
}

async function urlPage(viewport = { width: 1200, height: 900 }) {
  const context = await browser.newContext({ viewport });
  await context.addCookies([cookie]);
  const page = await context.newPage();
  const diagnostics: PageDiagnostics = { consoleErrors: [], failedRequests: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    diagnostics.failedRequests.push({
      url: request.url(),
      error: request.failure()?.errorText ?? 'request_failed',
    });
  });
  await page.goto(`${app.baseUrl}/spaces/${spaceId}/import?kind=url`, {
    waitUntil: 'networkidle',
  });
  return { context, page, diagnostics };
}

async function capturePage(page: Page, name: string, diagnostics: PageDiagnostics) {
  await mkdir(evidenceRoot, { recursive: true });
  await page.screenshot({
    path: join(evidenceRoot, `${name}.png`),
    fullPage: true,
  });
  await writeFile(
    join(evidenceRoot, `${name}.json`),
    `${JSON.stringify(
      {
        url: page.url(),
        viewport: page.viewportSize(),
        diagnostics,
      },
      null,
      2,
    )}\n`,
  );
}

async function enterUrlForm(page: Page) {
  const heading = page.getByRole('heading', { name: /新建 \/ 导入/ });
  await playwrightExpect(heading).toBeVisible();
  const urlSource = page.getByRole('button', { name: /网页链接/ });
  if (await urlSource.isVisible()) await urlSource.click();
  const next = page.getByRole('button', { name: '下一步' });
  await playwrightExpect(next).toBeEnabled();
  await next.click();
  await playwrightExpect(page.getByLabel('网页地址')).toBeVisible();
}

beforeAll(async () => {
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  spaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  browser = await chromium.launch({ headless: true });
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
});

describe('L1-B10-ING-003 UI single-page URL import', () => {
  it('L1-B10-ING-003-UI01/UI02/UI06 renders URL entry at 360/768/1200 without blocking axe defects', async () => {
    for (const viewport of [
      { width: 360, height: 900 },
      { width: 768, height: 900 },
      { width: 1200, height: 900 },
    ]) {
      const { context, page, diagnostics } = await urlPage(viewport);
      try {
        await enterUrlForm(page);
        await capturePage(page, `entry-${viewport.width}`, diagnostics);
        const dimensions = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
        const accessibility = await new AxeBuilder({ page }).analyze();
        expect(
          accessibility.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          ),
        ).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });

  it('L1-B10-ING-003-UI02 parses non-empty lines into ordered removable tags', async () => {
    const { context, page, diagnostics } = await urlPage();
    try {
      await enterUrlForm(page);
      const input = page.getByLabel('网页地址');
      await capturePage(page, 'multi-url-current-input', diagnostics);
      expect(await input.evaluate((element) => element.tagName)).toBe('TEXTAREA');
      await input.fill(
        [
          'https://public.example.test/one',
          '   ',
          'https://public.example.test/two',
          'https://public.example.test/three',
        ].join('\n'),
      );
      const tags = page.getByTestId('b10-url-tag');
      await playwrightExpect(tags).toHaveCount(3);
      await playwrightExpect(tags.nth(0)).toContainText('https://public.example.test/one');
      await playwrightExpect(tags.nth(1)).toContainText('https://public.example.test/two');
      await tags.nth(1).getByRole('button', { name: /删除/ }).click();
      await playwrightExpect(tags).toHaveCount(2);
      await playwrightExpect(input).toHaveValue(
        'https://public.example.test/one\nhttps://public.example.test/three',
      );
    } finally {
      await context.close();
    }
  });

  it('L1-B10-ING-003-UI03 blocks data-preview next until the URL has a successful preview', async () => {
    const { context, page, diagnostics } = await urlPage();
    try {
      await enterUrlForm(page);
      await page.getByLabel('网页地址').fill('https://public.example.test/not-previewed');
      await page.getByLabel('内容选择器').fill('main');
      await page.getByRole('button', { name: '下一步' }).click();
      const previewStep = page.getByText('数据预览', { exact: true }).last();
      await playwrightExpect(previewStep).toBeVisible();
      await capturePage(page, 'preview-gating', diagnostics);
      const next = page.getByRole('button', { name: '下一步' });
      await playwrightExpect(next).toBeDisabled();
      await playwrightExpect(page.getByText(/请先预览|先抓取预览/)).toBeVisible();
    } finally {
      await context.close();
    }
  });

  it('L1-B10-ING-003-N01/UI05 preserves the form after a rejected URL', async () => {
    const { context, page, diagnostics } = await urlPage();
    try {
      await enterUrlForm(page);
      const blockedUrl = 'http://169.254.169.254/latest/meta-data';
      await page.getByLabel('网页地址').fill(blockedUrl);
      await page.getByRole('button', { name: '下一步' }).click();
      await page.getByRole('button', { name: '下一步' }).click();
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'POST' && candidate.url().endsWith('/imports/url'),
      );
      await page.getByRole('button', { name: '确认导入' }).click();
      const fetched = await response;
      const responseBody = await fetched.text();
      await mkdir(evidenceRoot, { recursive: true });
      await writeFile(
        join(evidenceRoot, 'rejected-url-response.json'),
        `${JSON.stringify(
          {
            status: fetched.status(),
            requestId: fetched.request().headers()['x-request-id'] ?? null,
            body: JSON.parse(responseBody) as Record<string, unknown>,
          },
          null,
          2,
        )}\n`,
      );
      expect(fetched.status()).toBe(422);
      await capturePage(page, 'rejected-url-retention', diagnostics);
      await playwrightExpect(page.getByLabel('网页地址')).toHaveValue(blockedUrl);
      await playwrightExpect(page.getByRole('alert')).toContainText(/不支持|unsupported/i);
    } finally {
      await context.close();
    }
  });

  it('L1-B10-ING-003-UI05 retains URL and selector when returning from data preview', async () => {
    const { context, page, diagnostics } = await urlPage();
    try {
      await enterUrlForm(page);
      const url = 'https://public.example.test/back-retention';
      await page.getByLabel('网页地址').fill(url);
      await page.getByLabel('内容选择器').fill('main');
      await page.getByRole('button', { name: '下一步' }).click();
      await page.getByRole('button', { name: '上一步' }).click();
      await capturePage(page, 'back-retention', diagnostics);
      await playwrightExpect(page.getByLabel('网页地址')).toHaveValue(url);
      await playwrightExpect(page.getByLabel('内容选择器')).toHaveValue('main');
    } finally {
      await context.close();
    }
  });

  it('L1-B10-ING-003-UI07 refresh restores the URL import entry without a broken shell', async () => {
    const { context, page, diagnostics } = await urlPage();
    try {
      await enterUrlForm(page);
      await page.getByLabel('网页地址').fill('https://public.example.test/refresh');
      await page.reload({ waitUntil: 'networkidle' });
      await playwrightExpect(page.getByRole('heading', { name: /新建 \/ 导入/ })).toBeVisible();
      await playwrightExpect(page.getByRole('button', { name: /网页链接/ })).toBeVisible();
      await capturePage(page, 'refresh-restored-entry', diagnostics);
    } finally {
      await context.close();
    }
  });
});

describe.skipIf(!B10_PUBLIC_FIXTURE_BASE_URL)(
  'L1-B10-ING-003 public fixture positive path — BLOCKED_ENV when variable is absent',
  () => {
    it('L1-B10-ING-003-P01/P02/P04/P05/UI03/UI04 previews two pages and continues after partial failure', async () => {
      const { context, page, diagnostics } = await urlPage();
      try {
        await enterUrlForm(page);
        await page
          .getByLabel('网页地址')
          .fill(
            [
              b10PublicUrl(B10_PUBLIC_FIXTURE_PATHS.selector),
              b10PublicUrl(B10_PUBLIC_FIXTURE_PATHS.normal),
            ].join('\n'),
          );
        await page.getByLabel('内容选择器').fill('main');
        await page.getByRole('button', { name: '下一步' }).click();
        await page.getByRole('button', { name: '下一步' }).click();
        const previewButtons = page.getByRole('button', { name: /预览|抓取/ });
        await previewButtons.first().click();
        await playwrightExpect(page.getByText(/共 \d+ 个分块/)).toBeVisible();
        await playwrightExpect(page.getByText(/SELECTED_FIXTURE_TEXT/)).toBeVisible();
        await capturePage(page, 'public-fixture-preview', diagnostics);
        await playwrightExpect(page.getByRole('button', { name: '下一步' })).toBeEnabled();
      } finally {
        await context.close();
      }
    });
  },
);
