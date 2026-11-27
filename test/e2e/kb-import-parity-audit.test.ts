import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  chromium,
  expect as playwrightExpect,
  type Browser,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startB06aApp, type B06aAppHarness } from './b06a-harness';
import { apiHeaders, consoleCookie } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const runId = new Date()
  .toISOString()
  .replaceAll(':', '')
  .replace(/\.\d{3}Z$/, 'Z');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const evidenceDir = join(root, 'test-results', 'kb-import-parity-audit', runId);
const workspaceId = `ws_kb_import_parity_${suffix}`;
const memberId = `mem_kb_import_parity_${suffix}`;
const authToken = `kb-import-parity-${suffix}`;
const fileName = `heading-scroll-matrix-${suffix}.md`;

let app: B06aAppHarness;
let browser: Browser;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let spaceId = '';
let directoryId = '';

async function api<T = Record<string, unknown>>(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...apiHeaders({
        authToken,
        workspaceId,
        idempotencyKey: method === 'GET' ? undefined : `kb-import-parity-${suffix}-${randomUUID()}`,
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

function longMarkdown() {
  return readFileSync(join(root, 'test/fixtures/kb-import-heading-scroll-matrix.md'), 'utf8');
}

async function capture(page: Page, name: string) {
  const path = join(evidenceDir, `${name}.png`);
  const image = await page.screenshot({ path, fullPage: true });
  const metrics = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    };
    const scroll = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowY: getComputedStyle(element).overflowY,
      };
    };
    const headings = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.kb2-local-chunk-scroll h1, .kb2-local-chunk-scroll h2, .kb2-local-chunk-scroll h3',
      ),
    )
      .slice(0, 12)
      .map((element) => {
        const style = getComputedStyle(element);
        return {
          tag: element.tagName.toLowerCase(),
          text: element.textContent?.trim().slice(0, 100),
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
        };
      });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      page: {
        scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
      },
      importPage: rect('.kb2-import-page'),
      importMain: rect('.kb2-import-main'),
      importFooter: rect('.kb2-import-footer'),
      preview: rect('.kb2-local-file-preview'),
      chunkScroll: scroll('.kb2-local-chunk-scroll'),
      headings,
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
  const events: Array<Record<string, unknown>> = [];
  const captureRequest = (request: Request) => {
    if (!request.url().includes('/v1/knowledge/')) return;
    events.push({
      direction: 'request',
      method: request.method(),
      path: new URL(request.url()).pathname,
      postData: request.postData()?.slice(0, 4_000) ?? null,
    });
  };
  const captureResponse = (response: Response) => {
    if (!response.url().includes('/v1/knowledge/')) return;
    events.push({
      direction: 'response',
      status: response.status(),
      path: new URL(response.url()).pathname,
    });
  };
  page.on('request', captureRequest);
  page.on('response', captureResponse);
  return events;
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??=
    'mongodb://127.0.0.1:27017/kb_import_parity_audit?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
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
    name: `导入验收-20261126-${suffix}`,
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
  });
  spaceId = space.id;
  const directory = await api<{ id: string }>(
    `/v1/knowledge/spaces/${spaceId}/directories`,
    'POST',
    {
      name: `目标目录继承验收-${suffix}`,
      parentDirectoryId: null,
    },
  );
  directoryId = directory.id;
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
  browser = await chromium.launch({ headless: true });
  await writeFile(
    join(evidenceDir, 'fixture.json'),
    `${JSON.stringify(
      {
        runId,
        projectCommit: 'c1b752032de8',
        workspaceId,
        spaceId,
        directoryId,
        fileName,
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

describe('FastGPT local-file import parity', () => {
  it('matches the four-step navigation, settings, preview and confirmation layout', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const network = observeNetwork(page);
    const consoleErrors: string[] = [];
    const observations: Record<string, unknown> = {};
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    try {
      await page.goto(
        `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=import&source=fileLocal&parentId=${directoryId}`,
        { waitUntil: 'networkidle' },
      );
      await capture(page, 'step1-project-1440');

      observations.targetDirectoryCount = await page.getByText('目标目录', { exact: true }).count();
      observations.importHeadingCount = await page
        .getByRole('heading', { name: '新建 / 导入' })
        .count();
      observations.importSubtitleCount = await page.getByText('导入到', { exact: false }).count();
      observations.exitVisible = await page
        .getByText('退出', { exact: true })
        .isVisible()
        .catch(() => false);
      const exitBox = await page.getByRole('button', { name: '退出' }).boundingBox();
      observations.exitAtTopLeft = Boolean(exitBox) && exitBox!.x < 120 && exitBox!.y < 100;
      observations.stepOneBackButtonCount = await page
        .getByRole('button', { name: '上一步' })
        .count();

      await page.locator('input[type="file"]').setInputFiles({
        name: fileName,
        mimeType: 'text/markdown',
        buffer: Buffer.from(longMarkdown(), 'utf8'),
      });
      await playwrightExpect(page.getByText('上传完成', { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await page.getByRole('button', { name: '下一步' }).click();
      await playwrightExpect(page.getByText('数据处理方式设置', { exact: true })).toBeVisible();
      await capture(page, 'step2-project-chunk-1440');
      const stepTwoBackBox = await page.getByRole('button', { name: '上一步' }).boundingBox();
      observations.stepTwoBackAtTopLeft =
        Boolean(stepTwoBackBox) && stepTwoBackBox!.x < 120 && stepTwoBackBox!.y < 100;
      observations.stepTwoBackButtonCount = await page
        .getByRole('button', { name: '上一步' })
        .count();

      const titleCheckbox = page.getByRole('checkbox', { name: '将标题加入索引' });
      const autoCheckbox = page.getByRole('checkbox', { name: '自动生成补充索引' });
      const imageCheckbox = page.getByRole('checkbox', { name: '图片自动索引' });
      observations.autoIndexCheckboxVisible = await autoCheckbox.isVisible().catch(() => false);
      observations.autoIndexCheckboxEnabled = await autoCheckbox.isEnabled().catch(() => false);
      observations.imageIndexCheckboxVisible = await imageCheckbox.isVisible().catch(() => false);
      if (observations.autoIndexCheckboxEnabled) {
        await titleCheckbox.check();
        await autoCheckbox.check();
        await autoCheckbox.uncheck();
      } else {
        await titleCheckbox.check();
      }
      observations.titleStillCheckedAfterAutoOff = await titleCheckbox
        .isChecked()
        .catch(() => false);

      await page.getByRole('radio', { name: /问答对提取/ }).check();
      await capture(page, 'step2-project-qa-1440');
      observations.qaAutoIndexCount = await page
        .getByRole('checkbox', { name: '自动生成补充索引' })
        .count();
      observations.qaImageIndexCount = await page
        .getByRole('checkbox', { name: '图片自动索引' })
        .count();
      observations.qaChunkTriggerCount = await page.getByText('分块条件', { exact: true }).count();
      observations.qaChunkParameterCount = await page
        .getByText('分块处理参数', { exact: true })
        .count();

      await page.getByRole('radio', { name: /分块存储/ }).check();
      await page.getByRole('button', { name: '下一步' }).click();
      await playwrightExpect(page.getByText('文件列表', { exact: true })).toBeVisible();
      await page.locator('.kb2-local-file-row').filter({ hasText: fileName }).click();
      await playwrightExpect(page.locator('.kb2-chunk-preview').first()).toBeVisible({
        timeout: 60_000,
      });
      await capture(page, 'step3-project-preview-1440');

      const previewMetrics = await capture(page, 'step3-project-preview-measured-1440');
      const nextButton = page.getByRole('button', { name: '下一步' }).last();
      const nextBox = await nextButton.boundingBox();
      observations.previewMetrics = previewMetrics;
      observations.next1440VisibleWithoutPageScroll =
        Boolean(nextBox) &&
        (nextBox?.y ?? Number.POSITIVE_INFINITY) + (nextBox?.height ?? 0) <= 900;
      observations.next1440AtRight = (nextBox?.x ?? 0) + (nextBox?.width ?? 0) > 1440 / 2;

      await page.setViewportSize({ width: 1200, height: 900 });
      await page.waitForTimeout(200);
      await capture(page, 'step3-project-preview-1200');
      const nextBox1200 = await nextButton.boundingBox();
      observations.next1200VisibleWithoutPageScroll =
        Boolean(nextBox1200) &&
        (nextBox1200?.y ?? Number.POSITIVE_INFINITY) + (nextBox1200?.height ?? 0) <= 900;

      await page.setViewportSize({ width: 811, height: 1253 });
      await page.waitForTimeout(200);
      const preview811Metrics = await capture(page, 'step3-project-preview-811');
      observations.preview811Metrics = preview811Metrics;
      const nextBox811 = await nextButton.boundingBox();
      observations.next811VisibleWithoutPageScroll =
        Boolean(nextBox811) &&
        (nextBox811?.y ?? Number.POSITIVE_INFINITY) + (nextBox811?.height ?? 0) <= 1253;
      observations.preview811Columns = await page
        .locator('.kb2-local-file-preview')
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);

      await page.setViewportSize({ width: 1200, height: 900 });
      await page.waitForTimeout(200);
      await page.getByRole('button', { name: '下一步' }).last().click();
      await capture(page, 'step4-project-confirm-1200');
      observations.confirmUploadLabelCount = await page
        .getByText('确认上传', { exact: true })
        .count();
      observations.confirmSourceHeaderCount = await page
        .getByRole('columnheader', { name: /来源名|Source name/ })
        .count();
      observations.confirmStatusHeaderCount = await page
        .getByRole('columnheader', { name: /状态|Upload status/ })
        .count();
      observations.startUploadButtonCount = await page
        .getByRole('button', { name: /开始上传/ })
        .count();
      observations.confirmTableCount = await page.getByRole('table').count();
      observations.confirmWaitingCount = await page.getByText('等待中', { exact: true }).count();
    } finally {
      await writeFile(
        join(evidenceDir, 'browser-evidence.json'),
        `${JSON.stringify({ observations, network, consoleErrors }, null, 2)}\n`,
      );
      await context.close();
    }

    const preview = observations.previewMetrics as
      | {
          chunkScroll?: { overflowY?: string; clientHeight?: number; scrollHeight?: number } | null;
          headings?: Array<{ tag?: string; fontSize?: string; fontWeight?: string }>;
        }
      | undefined;
    const expected: Record<string, unknown> = {
      targetDirectoryCount: 0,
      importHeadingCount: 0,
      importSubtitleCount: 0,
      exitVisible: true,
      titleStillCheckedAfterAutoOff: true,
      exitAtTopLeft: true,
      stepOneBackButtonCount: 0,
      stepTwoBackAtTopLeft: true,
      stepTwoBackButtonCount: 1,
      qaAutoIndexCount: 0,
      qaImageIndexCount: 0,
      qaChunkTriggerCount: 0,
      qaChunkParameterCount: 1,
      next1440VisibleWithoutPageScroll: true,
      next1440AtRight: true,
      next1200VisibleWithoutPageScroll: true,
      next811VisibleWithoutPageScroll: true,
      preview811Columns: 2,
      confirmUploadLabelCount: 1,
      confirmSourceHeaderCount: 1,
      confirmStatusHeaderCount: 1,
      startUploadButtonCount: 1,
      confirmTableCount: 1,
      confirmWaitingCount: 1,
    };
    const mismatches = Object.entries(expected)
      .filter(([key, value]) => observations[key] !== value)
      .map(([key, value]) => ({ key, expected: value, actual: observations[key] }));
    const scrollable =
      preview?.chunkScroll &&
      ['auto', 'scroll'].includes(preview.chunkScroll.overflowY ?? '') &&
      (preview.chunkScroll.scrollHeight ?? 0) > (preview.chunkScroll.clientHeight ?? 0);
    if (!scrollable) {
      mismatches.push({ key: 'internallyScrollablePreview', expected: true, actual: preview });
    }
    const headingStyles = new Map(
      preview?.headings?.map((heading) => [
        heading.tag,
        `${heading.fontSize}/${heading.fontWeight}`,
      ]),
    );
    const expectedHeadingStyles = new Map([
      ['h1', '28px/700'],
      ['h2', '24px/700'],
      ['h3', '20px/700'],
    ]);
    if ([...expectedHeadingStyles].some(([tag, style]) => headingStyles.get(tag) !== style)) {
      mismatches.push({
        key: 'markdownHeadingHierarchy',
        expected: Object.fromEntries(expectedHeadingStyles),
        actual: preview?.headings,
      });
    }
    const previewPage = observations.previewMetrics as
      | {
          page?: { scrollY?: number; scrollHeight?: number; clientHeight?: number };
          viewport?: { height?: number };
        }
      | undefined;
    if (
      previewPage?.page?.scrollY !== 0 ||
      previewPage.page.scrollHeight !== previewPage.page.clientHeight ||
      previewPage.page.clientHeight !== previewPage.viewport?.height
    ) {
      mismatches.push({
        key: 'boundedImportPage',
        expected: 'document height equals viewport height with no page scroll',
        actual: previewPage,
      });
    }
    const preview811 = observations.preview811Metrics as
      | {
          page?: { scrollY?: number; scrollHeight?: number; clientHeight?: number };
          viewport?: { height?: number };
        }
      | undefined;
    if (
      preview811?.page?.scrollY !== 0 ||
      preview811.page.scrollHeight !== preview811.page.clientHeight ||
      preview811.page.clientHeight !== preview811.viewport?.height
    ) {
      mismatches.push({
        key: 'boundedImportPage811',
        expected: 'document height equals viewport height with no page scroll',
        actual: preview811,
      });
    }
    expect(mismatches, JSON.stringify(observations, null, 2)).toEqual([]);
  }, 180_000);

  it('creates sources individually and retries only the unfinished source', async () => {
    const retrySuffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const retrySpace = await api<{ id: string }>('/v1/knowledge/spaces', 'POST', {
      kind: 'space',
      name: `导入逐来源验收-${retrySuffix}`,
      accessMode: 'workspace',
      sourceAclMode: 'inherited',
      sourcePermissionEnabled: true,
    });
    const retryDirectory = await api<{ id: string }>(
      `/v1/knowledge/spaces/${retrySpace.id}/directories`,
      'POST',
      {
        name: `逐来源失败重试-${retrySuffix}`,
        parentDirectoryId: null,
      },
    );
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const importUploadIds: string[][] = [];
    let failSecondImport = true;
    await page.route('**/imports/files', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        uploadIds?: string[];
      };
      importUploadIds.push(body.uploadIds ?? []);
      if (importUploadIds.length === 2 && failSecondImport) {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    try {
      await page.goto(
        `${app.baseUrl}/dataset/detail?datasetId=${retrySpace.id}&currentTab=import&source=fileLocal&parentId=${retryDirectory.id}`,
        { waitUntil: 'networkidle' },
      );
      const firstFile = `partial-a-${retrySuffix}.md`;
      const secondFile = `partial-b-${retrySuffix}.md`;
      await page.locator('input[type="file"]').setInputFiles([
        {
          name: firstFile,
          mimeType: 'text/markdown',
          buffer: Buffer.from(`# ${firstFile}\n\n第一份验收内容。`, 'utf8'),
        },
        {
          name: secondFile,
          mimeType: 'text/markdown',
          buffer: Buffer.from(`# ${secondFile}\n\n第二份验收内容。`, 'utf8'),
        },
      ]);
      await playwrightExpect(page.getByText('上传完成', { exact: true })).toHaveCount(2, {
        timeout: 60_000,
      });
      await page.getByRole('button', { name: '下一步' }).click();
      await playwrightExpect(page.getByText('数据处理方式设置', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '下一步' }).click();
      await playwrightExpect(page.getByText('文件列表', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '下一步' }).click();
      await playwrightExpect(
        page.getByRole('columnheader', { name: '来源名', exact: true }),
      ).toBeVisible();

      await page.getByRole('button', { name: /2 个文件.*开始上传/ }).click();
      await playwrightExpect(page.getByText('完成', { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await playwrightExpect(page.getByText('错误', { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await playwrightExpect(
        page.getByRole('button', { name: /2 个文件.*继续上传/ }),
      ).toBeEnabled();
      await capture(page, 'step4-project-partial-retry-1200');
      expect(importUploadIds).toHaveLength(2);
      expect(importUploadIds[0]).toHaveLength(1);
      expect(importUploadIds[1]).toHaveLength(1);
      expect(importUploadIds[1]?.[0]).not.toBe(importUploadIds[0]?.[0]);

      failSecondImport = false;
      await page.getByRole('button', { name: /2 个文件.*继续上传/ }).click();
      await playwrightExpect(page.getByText('导入成功，请等待训练', { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await page.waitForURL((url) => url.searchParams.get('currentTab') === 'collectionCard', {
        timeout: 60_000,
      });
      expect(importUploadIds).toHaveLength(3);
      expect(importUploadIds[2]).toEqual(importUploadIds[1]);
    } finally {
      await context.close();
    }
  }, 180_000);
});
