import { randomUUID } from 'node:crypto';
import { chromium, expect as expectUi } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import {
  apiHeaders,
  consoleCookie,
  createSpace,
  requiredEnv,
  startS4App,
  verifyResponsivePage,
  type S4AppHarness,
} from './s4-app-harness';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s4_import_e2e_${suffix}`;
const memberId = `mem_s4_import_e2e_${suffix}`;
const authToken = `s4-import-e2e-token-${suffix}`;

let app: S4AppHarness | undefined;
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>> | undefined;
let spaceId = '';

beforeAll(async () => {
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  spaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
  connection = await createKnowledgeMongoConnection(requiredEnv('KB_TEST_MONGO_URI'));
  registerKnowledgeModels(connection);
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
});

describe('TEST-X-FRONTEND-IMPORT, TEST-DOWN-004-BLOCK and ACC-UI', () => {
  it('submits text through canonical runtime and keeps the parent Job unparsed', async () => {
    const response = await fetch(`${app!.baseUrl}/v1/knowledge/spaces/${spaceId}/imports/text`, {
      method: 'POST',
      headers: {
        ...apiHeaders({ authToken, workspaceId, idempotencyKey: `s4-text-${suffix}` }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        knowledgeSpaceId: spaceId,
        name: 'Manual note',
        directoryId: null,
        text: 'S4 text import body',
        chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
      }),
    });
    const payload = (await response.json()) as {
      success: boolean;
      data: { jobId: string; kind: string; status: string; result: unknown };
    };
    expect(response.status).toBe(202);
    expect(payload.data).toMatchObject({ kind: 'import', status: 'queued', result: null });
    expect(
      await connection!.models.KnowledgeJob.countDocuments({ workspaceId, kind: 'import' }),
    ).toBe(1);
    expect(await connection!.models.KnowledgeSource.countDocuments({ workspaceId })).toBe(1);
    expect(await connection!.models.KnowledgeSegment.countDocuments({ workspaceId })).toBe(0);
    expect(
      await connection!.models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        eventType: 'import.submit',
        status: 'pending',
      }),
    ).toBe(1);
  });

  it('ACC-UI-01/TEST-X-FRONTEND-A11Y renders the import workbench at three viewports', async () => {
    await verifyResponsivePage({
      baseUrl: app!.baseUrl,
      path: `/spaces/${spaceId}/import?kind=text`,
      cookie: await consoleCookie({ baseUrl: app!.baseUrl, authToken, workspaceId }),
      screenshotPrefix: 'import',
    });
  });

  it('ACC-UI-02 submits text from the UI and shows a queued parent Job', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const pageContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await pageContext.addCookies([
        await consoleCookie({ baseUrl: app!.baseUrl, authToken, workspaceId }),
      ]);
      const page = await pageContext.newPage();
      await page.goto(`${app!.baseUrl}/spaces/${spaceId}/import?kind=text`, {
        waitUntil: 'networkidle',
      });
      await page.locator('input').nth(1).fill('UI text');
      await page.locator('textarea').fill('Text submitted through ACC-UI-02');
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'POST' && candidate.url().endsWith('/imports/text'),
      );
      await page.getByRole('button', { name: /提交导入|Submit import/ }).click();
      expect((await response).status()).toBe(202);
      await expectUi(page.getByRole('status')).toContainText(/Import job queued|导入任务已排队/);

      const replay = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'POST' && candidate.url().endsWith('/imports/text'),
      );
      await page.getByRole('button', { name: /提交导入|Submit import/ }).click();
      expect((await replay).status()).toBe(202);
      await pageContext.close();
    } finally {
      await browser.close();
    }
  });

  it('ACC-UI-03 renders URL SSRF code, messageKey result and traceId', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const pageContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await pageContext.addCookies([
        await consoleCookie({ baseUrl: app!.baseUrl, authToken, workspaceId }),
      ]);
      const page = await pageContext.newPage();
      await page.goto(`${app!.baseUrl}/spaces/${spaceId}/import?kind=url`, {
        waitUntil: 'networkidle',
      });
      await page.locator('input').nth(1).fill('http://169.254.169.254/latest/meta-data');
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'POST' && candidate.url().endsWith('/imports/url'),
      );
      await page.getByRole('button', { name: /提交导入|Submit import/ }).click();
      expect((await response).status()).toBe(422);
      const notice = page.locator('.problem-notice');
      await expectUi(notice).toContainText('KNOWLEDGE_UNSUPPORTED_CONTENT');
      await expectUi(notice).toContainText(/trace|追踪/i);
    } finally {
      await browser.close();
    }
  });

  it('ACC-UI-04 surfaces parser rowNumber diagnostics', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const pageContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await pageContext.addCookies([
        await consoleCookie({ baseUrl: app!.baseUrl, authToken, workspaceId }),
      ]);
      const page = await pageContext.newPage();
      await page.goto(`${app!.baseUrl}/spaces/${spaceId}/import?kind=template`, {
        waitUntil: 'networkidle',
      });
      await page.locator('input[type=file]').setInputFiles({
        name: 'invalid-template.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('q,a\nQuestion,Answer\nQuestion,Other\n'),
      });
      await page.getByRole('button', { name: /上传|Upload/ }).click();
      await expectUi(page.getByText(/上传完成|Upload complete/)).toBeVisible();
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'POST' && candidate.url().endsWith('/imports/template'),
      );
      await page.getByRole('button', { name: /提交导入|Submit import/ }).click();
      expect((await response).status()).toBe(422);
      await expectUi(page.locator('.problem-notice')).toContainText(/Row 3|第 3 行/);
    } finally {
      await browser.close();
    }
  });

  it('ACC-UI-05 captures the API catalog request and renders catalog items', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const pageContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await pageContext.addCookies([
        await consoleCookie({ baseUrl: app!.baseUrl, authToken, workspaceId }),
      ]);
      const page = await pageContext.newPage();
      let requestBody: unknown;
      await page.route('**/imports/api-library/catalog', async (route) => {
        requestBody = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              provider: 'custom',
              items: [{ id: 'file:ui', name: 'UI fixture', type: 'document' }],
            },
          }),
        });
      });
      await page.goto(`${app!.baseUrl}/spaces/${spaceId}/import?kind=api_library`, {
        waitUntil: 'networkidle',
      });
      await page.locator('input[type=url]').fill('https://api.example.test');
      await page.getByRole('button', { name: /浏览目录|Browse catalog/ }).click();
      await expectUi(page.getByText(/UI fixture/)).toBeVisible();
      expect(requestBody).toMatchObject({
        parentId: '',
        config: {
          provider: 'custom_api',
          catalogPath: '/v1/file/list',
          pageMode: 'cursor',
        },
      });
    } finally {
      await browser.close();
    }
  });

  it('ACC-UI-07 preserves input on conflict and exposes retry', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const pageContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await pageContext.addCookies([
        await consoleCookie({ baseUrl: app!.baseUrl, authToken, workspaceId }),
      ]);
      const page = await pageContext.newPage();
      await page.route('**/imports/text', async (route) => {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: {
              code: 'KNOWLEDGE_CONFLICT',
              message: 'Conflict',
              retryable: true,
              details: { reason: 'idempotency_body_mismatch' },
            },
            requestId: 'req-ui-conflict',
            traceId: 'trace-ui-conflict',
          }),
        });
      });
      await page.goto(`${app!.baseUrl}/spaces/${spaceId}/import?kind=text`, {
        waitUntil: 'networkidle',
      });
      await page.locator('input').nth(1).fill('Keep this name');
      await page.locator('textarea').fill('Keep this body');
      await page.getByRole('button', { name: /提交导入|Submit import/ }).click();
      await expectUi(page.locator('.problem-notice')).toContainText('KNOWLEDGE_CONFLICT');
      await expectUi(page.locator('input').nth(1)).toHaveValue('Keep this name');
      await expectUi(page.locator('textarea')).toHaveValue('Keep this body');
      await expectUi(page.getByRole('button', { name: /重试|Retry/ })).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
