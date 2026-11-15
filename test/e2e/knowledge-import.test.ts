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
  // Legacy import-workbench coverage is retired with the old console shell.

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

  it('L1-B09-ING-006/ING-007-UI01 renders external-source controls at three viewports with axe', async () => {
    await verifyResponsivePage({
      baseUrl: app!.baseUrl,
      path: `/dataset/detail?datasetId=${spaceId}&currentTab=import&source=apiDataset`,
      cookie: await consoleCookie({ baseUrl: app!.baseUrl, authToken, workspaceId }),
      screenshotPrefix: 'b09-api-library',
      resultDir: 'b09/20261115-140502/ui',
    });
  });

  it.skip('ACC-UI-02 submits text from the UI and shows a queued parent Job', async () => {
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
      await page.getByRole('textbox', { name: '文本名称' }).fill('UI text');
      await page
        .getByRole('textbox', { name: '文本正文' })
        .fill('Text submitted through ACC-UI-02');
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

  it.skip('ACC-UI-03 renders URL SSRF code, messageKey result and traceId', async () => {
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
      await page
        .getByRole('textbox', { name: '页面 URL' })
        .fill('http://169.254.169.254/latest/meta-data');
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

  it.skip('ACC-UI-04 surfaces parser rowNumber diagnostics', async () => {
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

  it('L1-B09-ING-006-P01/S01/UI01 browses the API tree and preserves only explicit selections', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const pageContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await pageContext.addCookies([
        await consoleCookie({ baseUrl: app!.baseUrl, authToken, workspaceId }),
      ]);
      const page = await pageContext.newPage();
      let requestBody: unknown;
      let importBody: unknown;
      await page.route('**/imports/api-library', async (route) => {
        importBody = route.request().postDataJSON();
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { jobId: 'api-library-ui-job', kind: 'import', status: 'queued' },
          }),
        });
      });
      await page.route('**/imports/api-library/catalog', async (route) => {
        requestBody = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              provider: 'custom',
              items: [
                { id: 'folder:eng', name: 'Engineering', type: 'directory' },
                { id: 'file:existing', name: 'Existing runbook', type: 'document' },
                { id: 'file:keep', name: 'Keep runbook', type: 'document' },
              ],
              nextCursor: null,
            },
          }),
        });
      });
      await page.goto(
        `${app!.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=import&source=apiDataset`,
        {
          waitUntil: 'networkidle',
        },
      );
      await page.getByRole('button', { name: /下一步|Next/ }).click();
      await page
        .locator('.kb2-import-connect input[type=url]')
        .first()
        .fill('https://api.example.test');
      await expectUi(page.getByText('父目录 ID', { exact: true })).toHaveCount(0);
      const catalogResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().endsWith('/imports/api-library/catalog'),
      );
      await page.getByRole('button', { name: /读取 API 目录|Browse catalog/ }).click();
      expect((await catalogResponse).status()).toBe(200);
      await expectUi(page.getByText('Engineering')).toBeVisible();
      await expectUi(page.getByRole('checkbox', { name: /全选|select all/i })).toBeVisible();
      await expectUi(page.getByRole('checkbox', { name: /Existing runbook/ })).toBeDisabled();
      await page.getByRole('button', { name: /Engineering/ }).click();
      await expectUi(page.getByRole('navigation', { name: /breadcrumb|路径/i })).toContainText(
        /Engineering/,
      );
      await page.getByRole('checkbox', { name: /Keep runbook/ }).check();
      const importResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' && response.url().endsWith('/imports/api-library'),
      );
      await page.getByRole('button', { name: /提交导入|Submit import/ }).click();
      expect((await importResponse).status()).toBe(202);
      await expectUi(page.getByRole('status')).toContainText('api-library-ui-job');
      expect(requestBody).toMatchObject({
        parentId: 'folder:eng',
        config: {
          provider: 'custom_api',
          catalogPath: '/v1/file/list',
          pageMode: 'cursor',
        },
      });
      expect(requestBody).not.toHaveProperty('config.basePath');
      expect(importBody).toMatchObject({
        fileIds: ['file:keep'],
        config: {
          provider: 'custom_api',
          catalogPath: '/v1/file/list',
          pageMode: 'cursor',
        },
      });
      expect(importBody).not.toHaveProperty('config.basePath');
    } finally {
      await browser.close();
    }
  });

  it('L1-B09-ING-007-P01/UI01 selects Feishu documents from the configured tree', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const pageContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await pageContext.addCookies([
        await consoleCookie({ baseUrl: app!.baseUrl, authToken, workspaceId }),
      ]);
      const page = await pageContext.newPage();
      let catalogBody: unknown;
      let importBody: unknown;
      await page.route('**/spaces/*/connectors/feishu/catalog', async (route) => {
        catalogBody = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              provider: 'feishu',
              verificationStatus: 'EXTERNAL_UNVERIFIED',
              items: [
                {
                  externalId: 'feishu:folder:nested',
                  title: 'Nested folder',
                  type: 'directory',
                },
                {
                  externalId: 'feishu:docx:keep',
                  title: 'Feishu keep',
                  type: 'document',
                },
                {
                  externalId: 'feishu:docx:mutate',
                  title: 'Feishu mutate',
                  type: 'document',
                },
              ],
            },
          }),
        });
      });
      await page.route('**/spaces/*/connectors/feishu/import', async (route) => {
        importBody = route.request().postDataJSON();
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { jobId: 'connector-ui-job', kind: 'import', status: 'queued' },
          }),
        });
      });
      await page.goto(
        `${app!.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=import&source=feishu`,
        {
          waitUntil: 'networkidle',
        },
      );
      await page.getByRole('button', { name: /下一步|Next/ }).click();
      await expectUi(page.getByText('根目录 ID', { exact: true })).toHaveCount(0);
      const catalogResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().endsWith('/connectors/feishu/catalog'),
      );
      await page.getByRole('button', { name: /读取连接器目录|Browse catalog/ }).click();
      expect((await catalogResponse).status()).toBe(200);
      await expectUi(page.getByRole('button', { name: /Nested folder/ })).toBeVisible();
      await page.getByRole('button', { name: /Nested folder/ }).click();
      await expectUi(page.getByRole('navigation', { name: /breadcrumb|路径/i })).toContainText(
        /Nested folder/,
      );
      await expectUi(page.getByRole('textbox', { name: /外部 ID|External IDs/i })).toHaveCount(0);
      await page.getByRole('checkbox', { name: /Feishu keep/ }).check();
      await page.getByRole('checkbox', { name: /Feishu mutate/ }).check();
      const importResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().endsWith('/connectors/feishu/import'),
      );
      await page.getByRole('button', { name: /提交导入|Submit import/ }).click();
      expect((await importResponse).status()).toBe(202);
      await expectUi(page.getByRole('status')).toContainText('connector-ui-job');
      expect(catalogBody).toMatchObject({ rootId: expect.any(String) });
      expect(importBody).toMatchObject({
        externalIds: ['feishu:docx:keep', 'feishu:docx:mutate'],
      });
    } finally {
      await browser.close();
    }
  });

  it.skip('ACC-UI-07 preserves input on conflict and exposes retry', async () => {
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
      await page.getByRole('textbox', { name: '文本名称' }).fill('Keep this name');
      await page.getByRole('textbox', { name: '文本正文' }).fill('Keep this body');
      await page.getByRole('button', { name: /提交导入|Submit import/ }).click();
      await expectUi(page.locator('.problem-notice')).toContainText('KNOWLEDGE_CONFLICT');
      await expectUi(page.getByRole('textbox', { name: '文本名称' })).toHaveValue('Keep this name');
      await expectUi(page.getByRole('textbox', { name: '文本正文' })).toHaveValue('Keep this body');
      await expectUi(page.getByRole('button', { name: /重试|Retry/ })).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
