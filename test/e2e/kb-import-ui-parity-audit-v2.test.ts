import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startB06aApp, type B06aAppHarness } from './b06a-harness';
import { apiHeaders, consoleCookie } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const evidenceDir = join(root, 'docs/acceptance/kb-import-ui-parity-20261126-v3');
const workspaceId = `ws_kb_import_ui_v2_${suffix}`;
const memberId = `mem_kb_import_ui_v2_${suffix}`;
const authToken = `kb-import-ui-v2-${suffix}`;
const fixturePath = join(root, 'test/fixtures/kb-import-heading-scroll-matrix.md');

let app: B06aAppHarness;
let browser: Browser;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let spaceId = '';

async function api<T = Record<string, unknown>>(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...apiHeaders({
        authToken,
        workspaceId,
        idempotencyKey: method === 'GET' ? undefined : `kb-import-ui-v2-${randomUUID()}`,
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
    throw new Error(
      `${method} ${path} failed: ${response.status} ${payload.error?.code ?? 'unknown'}`,
    );
  }
  return payload.data as T;
}

async function capture(page: Page, name: string, waitFor?: string) {
  if (waitFor) {
    await playwrightExpect(page.getByText(waitFor, { exact: true }).first()).toBeVisible();
  }
  const image = await page.screenshot({ path: join(evidenceDir, `${name}.png`) });
  const metrics = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
        padding: style.padding,
        margin: style.margin,
        gap: style.gap,
        maxWidth: style.maxWidth,
        borderRadius: style.borderRadius,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        overflowY: style.overflowY,
      };
    };
    const scroll = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      return element
        ? {
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            overflowY: getComputedStyle(element).overflowY,
          }
        : null;
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        scrollY,
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight,
      },
      importPage: rect('.kb2-import-page'),
      steps: rect('.kb2-import-steps'),
      body: rect('.kb2-import-body'),
      main: rect('.kb2-import-main'),
      settings: rect('.kb2-import-settings'),
      preview: rect('.kb2-local-file-preview'),
      previewFiles: rect('.kb2-local-file-list'),
      previewChunks: rect('.kb2-local-chunk-preview'),
      previewScroll: scroll('.kb2-local-chunk-scroll'),
      confirmTable: rect('.kb2-import-upload-confirmation .kb2-table'),
      confirmHeaders: Array.from(
        document.querySelectorAll<HTMLElement>('.kb2-import-upload-confirmation th'),
      ).map((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          text: element.textContent?.trim(),
          width: Math.round(box.width),
          height: Math.round(box.height),
          padding: style.padding,
          background: style.backgroundColor,
          borderRadius: style.borderRadius,
        };
      }),
      footer: rect('.kb2-import-footer'),
      headings: Array.from(
        document.querySelectorAll<HTMLElement>(
          '.kb2-chunk-markdown h1, .kb2-chunk-markdown h2, .kb2-chunk-markdown h3',
        ),
      )
        .slice(0, 6)
        .map((element) => {
          const style = getComputedStyle(element);
          return {
            tag: element.tagName.toLowerCase(),
            text: element.textContent?.trim().slice(0, 80),
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
          };
        }),
    };
  });
  await writeFile(
    join(evidenceDir, `${name}.sha256`),
    `${createHash('sha256').update(image).digest('hex')}\n`,
  );
  await writeFile(
    join(evidenceDir, `${name}.metrics.json`),
    `${JSON.stringify(metrics, null, 2)}\n`,
  );
  return metrics;
}

function observeNetwork(page: Page) {
  const requests: Array<Record<string, unknown>> = [];
  page.on('request', (request) => {
    if (!request.url().includes('/v1/knowledge/')) return;
    requests.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      postData: request.postData() ?? null,
    });
  });
  return requests;
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??=
    'mongodb://127.0.0.1:27017/kb_import_ui_parity_v2?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/14';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-test';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';

  await mkdir(evidenceDir, { recursive: true });
  app = await startB06aApp({
    suffix,
    workspaceId,
    memberId,
    authToken,
    withWorker: true,
  });
  const space = await api<{ id: string }>('/v1/knowledge/spaces', 'POST', {
    kind: 'space',
    name: `四步导入验收-v2-${suffix}`,
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
  });
  spaceId = space.id;
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
  browser = await chromium.launch({ headless: true });
  await writeFile(
    join(evidenceDir, 'baseline.json'),
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        branch: 'codex/kb-import-parity-audit-20261126',
        head: 'c1b752032de802e52ef789e994114edf4d4639a6',
        workspaceId,
        spaceId,
        fixtureSha256: createHash('sha256').update(readFileSync(fixturePath)).digest('hex'),
      },
      null,
      2,
    )}\n`,
  );
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
});

describe('FastGPT four-step import UI parity', () => {
  it('records all interaction and backend parity gaps in one reproducible audit', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const network = observeNetwork(page);
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    const observations: Record<string, unknown> = {};
    const mismatches: Array<Record<string, unknown>> = [];

    try {
      await page.goto(
        `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=import&source=fileLocal`,
        { waitUntil: 'networkidle' },
      );
      observations.step1 = await capture(page, 'project-step1-empty-1440', '选择或拖放文件');
      await page.locator('input[type="file"]').setInputFiles({
        name: 'kb-import-ui-parity-v2.md',
        mimeType: 'text/markdown',
        buffer: readFileSync(fixturePath),
      });
      await playwrightExpect(page.getByText('上传完成', { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      observations.step1Uploaded = await capture(page, 'project-step1-uploaded-1440');
      await page.getByRole('button', { name: '下一步' }).click();
      await playwrightExpect(page.getByText('数据处理方式设置', { exact: true })).toBeVisible();
      const step2DefaultMetrics = await capture(page, 'project-step2-default-1440');
      observations.step2Default = step2DefaultMetrics;

      observations.step2UploadCompleteCount = await page
        .getByText('上传完成', { exact: true })
        .count();
      if (observations.step2UploadCompleteCount !== 0) {
        mismatches.push({
          id: 'UI-IMPORT-UPLOADROW-001',
          expected: 0,
          actual: observations.step2UploadCompleteCount,
        });
      }

      await page.getByRole('radio', { name: /自定义设置数据处理规则/ }).check();
      await page.getByRole('radio', { name: '按段落分块' }).check();
      await page.locator('.kb2-custom-parameters').scrollIntoViewIfNeeded();
      observations.step2Paragraph = await capture(page, 'project-step2-paragraph-1440');
      await page.getByRole('button', { name: '模型识别段落' }).click();
      observations.paragraphDescriptions = {
        auto: await page.getByText('当文本内容不含 Markdown 标题时，启用模型识别。').count(),
        forbid: await page.getByText('强制禁用模型自动识别段落').count(),
        force: await page.getByText('强制使用模型自动识别段落，并忽略原文本的段落（如有）').count(),
      };
      if (
        Object.values(observations.paragraphDescriptions as Record<string, number>).some(
          (value) => value === 0,
        )
      ) {
        mismatches.push({
          id: 'UI-PARAM-TOOLTIP-001',
          expected: 'three visible select descriptions',
          actual: observations.paragraphDescriptions,
        });
      }
      await page.keyboard.press('Escape');

      observations.numberInputs = await page
        .locator('.kb2-custom-fields input[type="number"]')
        .evaluateAll((elements) =>
          elements.map((element) => ({
            value: (element as HTMLInputElement).value,
            min: (element as HTMLInputElement).min,
            max: (element as HTMLInputElement).max,
            step: (element as HTMLInputElement).step,
            label: element.closest('.kb2-settings-field')?.textContent?.trim().slice(0, 160) ?? '',
          })),
        );
      observations.selectOptions = await page.locator('select').evaluateAll((elements) =>
        elements.map((element) => ({
          value: (element as HTMLSelectElement).value,
          options: Array.from((element as HTMLSelectElement).options).map((option) => ({
            value: option.value,
            text: option.textContent?.trim(),
          })),
        })),
      );

      await page.getByRole('radio', { name: '按指定分隔符分块' }).check();
      observations.step2Delimiter = await capture(page, 'project-step2-delimiter-1440');
      observations.delimiterSelectCount = await page.locator('.kb2-custom-fields select').count();
      observations.delimiterTextareaCount = await page
        .locator('.kb2-custom-fields textarea')
        .count();
      if (observations.delimiterSelectCount !== 1 || observations.delimiterTextareaCount !== 0) {
        mismatches.push({
          id: 'UI-PARAM-DELIMITER-001',
          expected: { selects: 1, textareas: 0 },
          actual: {
            selects: observations.delimiterSelectCount,
            textareas: observations.delimiterTextareaCount,
          },
        });
      }
      const delimiterSelect = page.getByLabel('分隔符', { exact: true });
      await playwrightExpect(delimiterSelect).toHaveValue('');
      await delimiterSelect.selectOption('custom');
      await playwrightExpect(page.getByLabel('自定义分隔符', { exact: true })).toBeVisible();
      await delimiterSelect.selectOption('.|。');
      await playwrightExpect(page.getByLabel('自定义分隔符', { exact: true })).toHaveCount(0);

      await page.getByRole('radio', { name: /问答对提取/ }).check();
      observations.step2Qa = await capture(page, 'project-step2-qa-1440');
      observations.qaPromptLabelCount = await page
        .getByText('QA 拆分引导词', { exact: true })
        .count();
      observations.qaPromptDefaultVisible = await page
        .getByText('最多提出 50 个问题。', { exact: false })
        .count();
      if (observations.qaPromptLabelCount !== 1 || observations.qaPromptDefaultVisible === 0) {
        mismatches.push({
          id: 'UI-PARAM-QA-PROMPT-001',
          expected: { label: 1, defaultPromptVisible: '>0' },
          actual: {
            label: observations.qaPromptLabelCount,
            defaultPromptVisible: observations.qaPromptDefaultVisible,
          },
        });
      }

      await page.getByRole('radio', { name: '按段落分块' }).check();
      observations.qaParagraph = await capture(page, 'project-step2-qa-paragraph-1440');
      observations.qaNumberInputs = await page
        .locator('.kb2-custom-fields input[type="number"]')
        .evaluateAll((elements) =>
          elements.map((element) => ({
            value: (element as HTMLInputElement).value,
            min: (element as HTMLInputElement).min,
            max: (element as HTMLInputElement).max,
            step: (element as HTMLInputElement).step,
          })),
        );

      await page.locator('.kb2-prompt-preview').hover();
      await playwrightExpect(
        page.getByRole('button', { name: '自定义提示词' }).first(),
      ).toBeVisible();
      await page.getByRole('button', { name: '自定义提示词' }).first().click();
      await page.waitForTimeout(300);
      observations.qaPromptDialog = await capture(page, 'project-step2-qa-prompt-dialog-1200');
      observations.qaPromptDialogText = await page.getByRole('dialog').innerText();
      expect(observations.qaPromptDialogText).toContain('固定响应格式');
      expect(observations.qaPromptDialogText).toContain('<Context>');
      expect(observations.qaPromptDialogText).toContain('{{text}}');
      await page.getByRole('dialog').getByRole('button', { name: '完成' }).click();

      const requestCountBeforePreview = network.length;
      await page.getByRole('button', { name: '下一步' }).click();
      await playwrightExpect(page.getByText('文件列表', { exact: true })).toBeVisible();
      await playwrightExpect(page.getByText('尚未选择文件', { exact: true })).toBeVisible();
      const unselectedPreviewMetrics = await capture(page, 'project-step3-preview-unselected-1440');
      observations.previewUnselected = unselectedPreviewMetrics;
      expect(unselectedPreviewMetrics.preview?.y).toBeLessThanOrEqual(
        unselectedPreviewMetrics.body.y + 20,
      );
      expect(unselectedPreviewMetrics.preview?.height).toBeGreaterThan(600);
      expect(unselectedPreviewMetrics.previewFiles?.height).toBe(
        unselectedPreviewMetrics.previewChunks?.height,
      );
      expect(unselectedPreviewMetrics.document.scrollY).toBe(0);
      await page.locator('.kb2-local-file-row').first().click();
      await playwrightExpect(page.locator('.kb2-chunk-preview').first()).toBeVisible({
        timeout: 60_000,
      });
      await page.waitForTimeout(500);
      const previewRequest = network
        .slice(requestCountBeforePreview)
        .find(
          (request) =>
            String(request.path).includes('preview') || String(request.path).includes('import'),
        );
      observations.qaPreviewRequest = previewRequest?.postData ?? null;
      const qaPayload = JSON.parse(String(previewRequest?.postData ?? '{}')) as {
        chunking?: Record<string, unknown>;
      };
      observations.qaChunkingPayload = qaPayload.chunking ?? null;
      if (
        !qaPayload.chunking ||
        !('paragraphChunkAIMode' in qaPayload.chunking) ||
        !('paragraphChunkDeep' in qaPayload.chunking)
      ) {
        mismatches.push({
          id: 'BE-PARAM-QA-PAYLOAD-001',
          expected: 'QA payload includes paragraphChunkAIMode and paragraphChunkDeep',
          actual: observations.qaChunkingPayload,
        });
      }
      const previewMetrics = await capture(page, 'project-step3-preview-1440');
      observations.preview = previewMetrics;
      expect(step2DefaultMetrics.settings?.width).toBe(640);
      expect(step2DefaultMetrics.steps.width).toBe(900);
      expect(step2DefaultMetrics.importPage.padding).toBe('20px 36px');
      expect(previewMetrics.previewFiles?.width).toBe(previewMetrics.previewChunks?.width);
      expect(previewMetrics.document.scrollY).toBe(0);
      expect(previewMetrics.previewScroll?.scrollHeight).toBeGreaterThan(
        previewMetrics.previewScroll?.clientHeight ?? 0,
      );

      await page.setViewportSize({ width: 1200, height: 900 });
      observations.preview1200 = await capture(page, 'project-step3-preview-1200');
      await page.setViewportSize({ width: 811, height: 1253 });
      observations.preview811 = await capture(page, 'project-step3-preview-811');
      await page.setViewportSize({ width: 1200, height: 900 });
      await page.getByRole('button', { name: '下一步' }).last().click();
      const confirmMetrics = await capture(page, 'project-step4-confirm-1200', '来源名');
      observations.confirm = confirmMetrics;
      observations.confirmHeaders = await page.getByRole('columnheader').allTextContents();
      observations.confirmButton = await page
        .getByRole('button', { name: /开始上传/ })
        .innerText()
        .catch(() => '');
      expect(confirmMetrics.confirmTable?.width).toBe(confirmMetrics.main.width);
      expect(confirmMetrics.confirmHeaders.map((item) => item.text)).toEqual([
        '来源名',
        '状态',
        '操作',
      ]);
      expect(confirmMetrics.confirmHeaders.every((item) => item.height === 48)).toBe(true);
      expect(confirmMetrics.confirmHeaders[0]?.width).toBeGreaterThan(
        confirmMetrics.confirmHeaders[2]?.width ?? 0,
      );
    } finally {
      await writeFile(
        join(evidenceDir, 'browser-evidence.json'),
        `${JSON.stringify({ observations, network, consoleErrors, mismatches }, null, 2)}\n`,
      );
      await context.close();
    }

    expect(mismatches).toEqual([]);
  }, 180_000);
});
