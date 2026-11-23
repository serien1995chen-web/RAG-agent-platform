import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHeaders, consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const runId = new Date()
  .toISOString()
  .replaceAll(':', '')
  .replace(/\.\d{3}Z$/, 'Z');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_kb_create_import_${suffix}`;
const memberId = `mem_kb_create_import_${suffix}`;
const authToken = `kb-create-import-${suffix}`;
const resultDir = join(root, 'test-results', 'kb-create-import', runId);

let app: S4AppHarness;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let browser: Browser;
let datasetId = '';

async function api<T = Record<string, unknown>>(
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...apiHeaders({
        authToken,
        workspaceId,
        idempotencyKey: method === 'GET' ? undefined : `kb-create-import-${suffix}-${randomUUID()}`,
      }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: { code?: string };
  };
  if (!response.ok || payload.success !== true) {
    throw new Error(`${method} ${path} failed: ${response.status} ${payload.error?.code ?? ''}`);
  }
  return payload.data as T;
}

async function pageContext(viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN' });
  await context.addCookies([cookie]);
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  return { context, page };
}

async function capture(page: Page, name: string) {
  await page.screenshot({
    path: join(resultDir, `${name}-${page.viewportSize()?.width ?? 'unknown'}.png`),
    fullPage: true,
  });
}

async function openCreateMenu(page: Page) {
  await page.goto(`${app.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await playwrightExpect(page.getByRole('menu')).toBeVisible();
}

async function openCreateType(page: Page, label: string) {
  await openCreateMenu(page);
  const thirdParty = page.getByRole('menuitem', { name: /第三方知识库/ }).first();
  if ((await thirdParty.count()) > 0) {
    await thirdParty.hover();
    const nested = page.getByRole('menuitem', { name: new RegExp(label) }).first();
    if (await nested.isVisible().catch(() => false)) {
      await nested.click();
      return;
    }
  }
  await page
    .getByRole('menuitem', { name: new RegExp(label) })
    .first()
    .click();
}

async function openImport(page: Page, source = 'fileLocal') {
  await page.goto(
    `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=import&source=${source}`,
    { waitUntil: 'networkidle' },
  );
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??=
    'mongodb://127.0.0.1:27017/kb_create_import_acceptance?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-test';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';

  await mkdir(resultDir, { recursive: true });
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
  const dataset = await api<{ id: string }>('/v1/knowledge/spaces', 'POST', {
    kind: 'space',
    parentSpaceId: null,
    name: `创建导入验收 ${suffix}`,
    description: 'KB-CI acceptance fixture',
    iconKey: 'book-open',
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
  });
  datasetId = dataset.id;
  browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  if (datasetId) {
    const latest = await api<{ version: number; referenceRevision: number }>(
      `/v1/knowledge/spaces/${datasetId}`,
      'GET',
    ).catch(() => null);
    if (latest) {
      await api(`/v1/knowledge/spaces/${datasetId}`, 'DELETE', {
        version: latest.version,
        expectedReferenceRevision: latest.referenceRevision,
        referenceStrategy: 'block',
      }).catch(() => undefined);
    }
  }
  await app?.close();
}, 60_000);

describe('FastGPT creation entry compatibility', () => {
  it('KB-CI-ENTRY-001/002 preserves the top-level create menu grouping and website entry', async () => {
    const { context, page } = await pageContext();
    try {
      await openCreateMenu(page);
      await capture(page, 'create-menu');

      const menuNames = await page
        .getByRole('menuitem')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.textContent?.trim().replace(/\s+/g, ' ') ?? ''),
        );
      expect
        .soft(menuNames.slice(0, 4))
        .toEqual([
          expect.stringContaining('通用知识库'),
          expect.stringContaining('网站知识库'),
          expect.stringContaining('第三方知识库'),
          expect.stringContaining('文件夹'),
        ]);

      await playwrightExpect
        .soft(page.getByText('通过爬虫，批量爬取网页数据构建知识库', { exact: true }))
        .toBeVisible();
      const thirdParty = page.getByRole('menuitem', { name: /第三方知识库/ }).first();
      await playwrightExpect.soft(thirdParty).toBeVisible();
      await thirdParty.hover();
      for (const label of ['API 文件库', '飞书知识库', '语雀知识库', '钉钉知识库']) {
        await playwrightExpect
          .soft(page.getByRole('menuitem', { name: new RegExp(label) }).first())
          .toBeVisible();
      }
    } finally {
      await context.close();
    }
  });

  it('KB-CI-CREATE-001/002/003 exposes the common model and compliance fields', async () => {
    const { context, page } = await pageContext();
    try {
      await openCreateType(page, '通用知识库');
      const dialog = page.getByRole('dialog');
      await capture(page, 'general-create-form');

      const name = dialog.getByRole('textbox').first();
      await playwrightExpect.soft(name).toBeFocused();
      await playwrightExpect.soft(name).toHaveAttribute('maxlength', '30');
      await playwrightExpect.soft(dialog.getByText(/索引模型|向量模型/).first()).toBeVisible();
      await playwrightExpect
        .soft(dialog.getByText(/文本理解模型|Dataset Agent Model/).first())
        .toBeVisible();
      await playwrightExpect.soft(dialog.getByText(/图片理解模型|VLM|vllm/i).first()).toBeVisible();
      await playwrightExpect
        .soft(dialog.getByText(/请确保您的内容严格遵守相关法律法规/))
        .toBeVisible();
      await playwrightExpect
        .soft(dialog.getByRole('button', { name: '关闭', exact: true }))
        .toBeVisible();

      const accessibility = await new AxeBuilder({ page }).analyze();
      expect
        .soft(
          accessibility.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          ),
        )
        .toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('KB-CI-CREATE-004 uses the folder-specific top-level form', async () => {
    const { context, page } = await pageContext();
    try {
      await openCreateType(page, '文件夹');
      const dialog = page.getByRole('dialog');
      await capture(page, 'folder-create-form');

      await playwrightExpect.soft(dialog).toHaveAccessibleName(/创建文件夹/);
      await playwrightExpect.soft(dialog.locator('input')).toHaveCount(1);
      await playwrightExpect.soft(dialog.locator('textarea')).toHaveCount(1);
      await playwrightExpect
        .soft(dialog.locator('input').first())
        .toHaveAttribute('maxlength', '100');
      await playwrightExpect
        .soft(dialog.getByRole('button', { name: /确认|创建/ }).last())
        .toBeVisible();
    } finally {
      await context.close();
    }
  });

  it.each([
    {
      label: 'API 文件库',
      requiredInputTypes: ['url', 'password'],
    },
    {
      label: '飞书知识库',
      requiredInputTypes: ['password'],
    },
    {
      label: '语雀知识库',
      requiredInputTypes: ['password'],
    },
    {
      label: '钉钉知识库',
      requiredInputTypes: ['password'],
    },
  ])(
    'KB-CI-CREATE-010 preserves the $label credential and model fields',
    async ({ label, requiredInputTypes }) => {
      const { context, page } = await pageContext();
      try {
        await openCreateType(page, label);
        const dialog = page.getByRole('dialog');
        await capture(page, `${label}-create-form`);
        for (const type of requiredInputTypes) {
          await playwrightExpect
            .soft(dialog.locator(`input[type="${type}"]`).first())
            .toBeVisible();
        }
        expect.soft(await dialog.locator('input').count()).toBeGreaterThanOrEqual(3);
        await playwrightExpect.soft(dialog.getByText(/索引模型|向量模型/).first()).toBeVisible();
        await playwrightExpect
          .soft(dialog.getByText(/文本理解模型|Dataset Agent Model/).first())
          .toBeVisible();
        await playwrightExpect
          .soft(dialog.getByText(/图片理解模型|VLM|vllm/i).first())
          .toBeVisible();
      } finally {
        await context.close();
      }
    },
  );

  it('KB-CI-CREATE-011 validates an API address with the expected inline message', async () => {
    const { context, page } = await pageContext();
    try {
      await openCreateType(page, 'API 文件库');
      const dialog = page.getByRole('dialog');
      const inputs = dialog.getByRole('textbox');
      await inputs.first().fill(`API 校验 ${suffix}`);
      const urlInput = dialog.locator('input[type="url"]').first();
      await urlInput.fill('abc');
      const authInput = dialog.locator('input[type="password"]').first();
      if ((await authInput.count()) > 0) await authInput.fill('dummy');
      await dialog.getByRole('button', { name: '创建', exact: true }).click();
      await page.waitForTimeout(200);
      await capture(page, 'api-url-validation');
      await playwrightExpect
        .soft(dialog.getByText('请输入完整地址，需以 http:// 或 https:// 开头'))
        .toBeVisible();
      await playwrightExpect.soft(dialog).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

describe('FastGPT import entry compatibility', () => {
  it('KB-CI-IMPORT-001 exposes the six-item New/Import menu before choosing a source', async () => {
    const { context, page } = await pageContext();
    try {
      await page.goto(
        `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=collectionCard`,
        { waitUntil: 'networkidle' },
      );
      await page.getByRole('button', { name: /新建\s*\/\s*导入/ }).click();
      await capture(page, 'import-menu');

      const expected = ['文件夹', '文本数据集', '图片数据集', '空白数据集', '模版导入', '备份导入'];
      const actual = await page
        .getByRole('menuitem')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.textContent?.trim().replace(/\s+/g, ' ') ?? ''),
        );
      for (const label of expected) {
        await playwrightExpect
          .soft(page.getByRole('menuitem', { name: new RegExp(label) }).first())
          .toBeVisible();
      }
      expect
        .soft(actual.slice(0, expected.length))
        .toEqual(expected.map((label) => expect.stringContaining(label)));
    } finally {
      await context.close();
    }
  });

  it('KB-CI-IMPORT-006 creates a named empty dataset through the New/Import menu', async () => {
    const { context, page } = await pageContext();
    const name = `空白数据集 ${suffix}`;
    try {
      await page.goto(
        `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=collectionCard`,
        { waitUntil: 'networkidle' },
      );
      await page.getByRole('button', { name: /新建\s*\/\s*导入/ }).click();
      await page.getByRole('menuitem', { name: /空白数据集/ }).click();
      const dialog = page.getByRole('dialog');
      await playwrightExpect(dialog).toHaveAccessibleName(/创建手动数据集/);
      await dialog.getByLabel('名称').fill(name);
      await dialog.getByRole('button', { name: '确认' }).click();
      await playwrightExpect(page.getByText(name, { exact: true }).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  it('KB-CI-IMPORT-002 presents local/web/custom text as a three-choice source step', async () => {
    const { context, page } = await pageContext();
    try {
      await page.goto(
        `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=collectionCard`,
        { waitUntil: 'networkidle' },
      );
      await page.getByRole('button', { name: /新建\s*\/\s*导入/ }).click();
      await page.getByRole('menuitem', { name: /文本数据集/ }).click();
      await capture(page, 'text-source-step');

      for (const label of ['本地文件', '网页链接', '自定义文本']) {
        await playwrightExpect
          .soft(page.getByRole('radio', { name: new RegExp(label) }).first())
          .toBeVisible();
      }
      await playwrightExpect
        .soft(page.getByRole('radio', { name: /本地文件/ }).first())
        .toBeChecked();
      await playwrightExpect.soft(page.getByRole('dialog')).toHaveAccessibleName(/选择来源/);
    } finally {
      await context.close();
    }
  });

  it('KB-CI-IMPORT-003 keeps file selection and parameter configuration on separate steps', async () => {
    const { context, page } = await pageContext();
    try {
      await openImport(page, 'fileLocal');
      await capture(page, 'text-file-selection-step');

      await playwrightExpect.soft(page.getByLabel('训练类型')).toHaveCount(0);
      await playwrightExpect.soft(page.getByText('PDF增强解析', { exact: true })).toHaveCount(0);
      await playwrightExpect.soft(page.locator('input[type="file"]')).toHaveCount(1);
    } finally {
      await context.close();
    }
  });

  it('KB-CI-PARAM-001 exposes the FastGPT text processing parameter semantics', async () => {
    const { context, page } = await pageContext();
    try {
      await openImport(page, 'fileLocal');
      await page.locator('input[type="file"]').setInputFiles({
        name: `验收文本-${suffix}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.from(
          '退款通常在五个工作日内到账。\n\nFASTGPT_IMPORT_ACCEPTANCE_END',
          'utf8',
        ),
      });
      await playwrightExpect(page.getByText('completed', { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await page.getByRole('button', { name: '下一步' }).click();
      await capture(page, 'text-parameter-step');
      for (const text of ['PDF增强解析', '标题加入索引', '图片自动索引']) {
        await playwrightExpect.soft(page.getByText(text, { exact: true }).first()).toBeVisible();
      }
      await playwrightExpect
        .soft(page.getByRole('option', { name: /分块存储|分段/ }).first())
        .toBeAttached();
      await playwrightExpect
        .soft(page.getByRole('option', { name: /问答对提取|问答对/ }).first())
        .toBeAttached();
      await playwrightExpect.soft(page.locator('input[value="1000"]').first()).toBeVisible();
      await page.getByRole('button', { name: '下一步' }).click();
      await capture(page, 'text-preview-step');
    } finally {
      await context.close();
    }
  });

  it('KB-CI-IMPORT-010 lets an empty custom-text draft submit into first-error focus', async () => {
    const { context, page } = await pageContext();
    try {
      await openImport(page, 'fileCustom');
      const next = page.getByRole('button', { name: '下一步' });
      await capture(page, 'custom-text-empty');

      await playwrightExpect.soft(next).toBeEnabled();
      if (await next.isEnabled()) {
        await next.click();
        await playwrightExpect.soft(page.getByRole('textbox').first()).toBeFocused();
      }
    } finally {
      await context.close();
    }
  });

  it('KB-CI-IMPORT-011 opens the image dataset form directly from the import menu', async () => {
    const { context, page } = await pageContext();
    try {
      await openImport(page, 'imageDataset');
      await capture(page, 'image-import-entry');

      const dialog = page.getByRole('dialog');
      await playwrightExpect.soft(page.getByText(/数据集名称|名称/).first()).toBeVisible();
      await playwrightExpect.soft(page.getByText(/数据集内容|选择图片/).first()).toBeVisible();
      await playwrightExpect.soft(dialog.locator('input[type="file"]')).toHaveCount(1);
      await playwrightExpect.soft(page.getByText('参数设置', { exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  it.each(['template', 'backup'])(
    'KB-CI-IMPORT-013 opens the %s import as a direct one-file dialog',
    async (source) => {
      const { context, page } = await pageContext();
      try {
        await page.goto(
          `${app.baseUrl}/dataset/detail?datasetId=${datasetId}&currentTab=collectionCard`,
          { waitUntil: 'networkidle' },
        );
        await page.getByRole('button', { name: /新建\s*\/\s*导入/ }).click();
        await page
          .getByRole('menuitem', {
            name: source === 'template' ? /模版导入/ : /备份导入/,
          })
          .click();
        await capture(page, `${source}-import-entry`);

        await playwrightExpect.soft(page.getByRole('dialog')).toBeVisible();
        await playwrightExpect
          .soft(page.getByRole('dialog').locator('input[type="file"]'))
          .toHaveCount(1);
        await playwrightExpect.soft(page.getByText('确认导入', { exact: true })).toBeVisible();
      } finally {
        await context.close();
      }
    },
  );

  it('KB-CI-IMPORT-012 keeps import layouts usable and accessible across desktop widths', async () => {
    const { context, page } = await pageContext();
    try {
      await openImport(page, 'fileLocal');
      for (const width of [1440, 1200, 900]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(100);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect.soft(overflow, `${width}px horizontal overflow`).toBeLessThanOrEqual(1);
        await capture(page, 'import-responsive');
      }
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect
        .soft(
          accessibility.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          ),
        )
        .toEqual([]);
    } finally {
      await context.close();
    }
  });
});
