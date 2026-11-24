import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startB12ImageDeepHarness,
  type B12ImageDeepHarness,
  type B12ImageDeepRequest,
} from './b12-image-deep-harness';
import { consoleCookie } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const screenshotDir = process.env.S11_UI_EVIDENCE_DIR
  ? join(process.env.S11_UI_EVIDENCE_DIR, 's8-ui')
  : join(root, 'docs/acceptance/s8-ui');

let fixture: B12ImageDeepHarness;
let app: B12ImageDeepHarness['app'];
let connection: B12ImageDeepHarness['connection'];
let suffix = '';
let workspaceId = '';
let memberId = '';
let authToken = '';
let spaceId = '';
let imageSourceId = '';
let imageBlobRefId = '';

async function assertSkipLinkDoesNotOverlap(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.waitForTimeout(50);
  const geometry = await page.evaluate(() => {
    const skip = document.querySelector<HTMLElement>('.skip-link, .kb2-skip-link');
    const nav = document.querySelector<HTMLElement>(
      'aside[aria-label="Primary navigation"], aside[aria-label="主导航"]',
    );
    const heading = document.querySelector<HTMLElement>('h1');
    if (!skip)
      return { present: false, visible: false, overlapsNav: false, overlapsHeading: false };
    const skipBox = skip.getBoundingClientRect();
    const navBox = nav?.getBoundingClientRect();
    const headingBox = heading?.getBoundingClientRect();
    const style = getComputedStyle(skip);
    const intersects = (left: DOMRect | undefined, right: DOMRect | undefined): boolean => {
      if (!left || !right) return false;
      return !(
        left.right <= right.left ||
        right.right <= left.left ||
        left.bottom <= right.top ||
        right.bottom <= left.top
      );
    };
    const visible =
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      style.clipPath !== 'inset(50%)' &&
      skipBox.width > 1 &&
      skipBox.height > 1 &&
      skipBox.bottom > 0 &&
      skipBox.right > 0;
    return {
      present: true,
      visible,
      overlapsNav: visible && intersects(skipBox, navBox),
      overlapsHeading: visible && intersects(skipBox, headingBox),
    };
  });
  expect(geometry.present).toBe(true);
  expect(geometry.visible).toBe(false);
  expect(geometry.overlapsNav).toBe(false);
  expect(geometry.overlapsHeading).toBe(false);
}

async function request(path: string, input: B12ImageDeepRequest = {}) {
  return fixture.request(path, input);
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_s8_page?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-local';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';
  fixture = await startB12ImageDeepHarness();
  ({
    suffix,
    workspaceId,
    memberId,
    authToken,
    app,
    connection,
    spaceId,
    imageSourceId,
    imageBlobRefId,
  } = fixture);
}, 240_000);

afterAll(async () => {
  await fixture?.close();
});

describe('S8 real app image and deep search routes', () => {
  // The standalone Images page is now represented by the product Import image tab and Search tab.

  it('serves image search with controlled citation and Deep search with its stop contract', async () => {
    const image = await request('/v1/knowledge/search/image', {
      method: 'POST',
      idempotencyKey: `s8-image-search-${suffix}`,
      body: {
        knowledgeSpaceId: spaceId,
        query: 'refund flow',
        tokenBudget: 5_000,
        imageUploadIds: [imageBlobRefId],
        searchMode: 'hybrid',
      },
    });
    expect(image.response.status, JSON.stringify(image.payload)).toBe(200);
    expect(
      (image.payload.data.items as Array<{ segment: { imageBlobRefId: string | null } }>).some(
        (item) => item.segment.imageBlobRefId === imageBlobRefId,
      ),
    ).toBe(true);
    expect(JSON.stringify(image.payload)).not.toContain('objectKey');

    const deep = await request('/v1/knowledge/search/deep', {
      method: 'POST',
      idempotencyKey: `s8-deep-search-${suffix}`,
      body: {
        knowledgeSpaceId: spaceId,
        knowledgeSpaceIds: [spaceId],
        query: 'refunds',
        tokenBudget: 12_000,
        maxRounds: 3,
        roundTokenBudget: 5_000,
        stopWhenNoNewEvidence: true,
        similarity: 0,
        searchMode: 'hybrid',
      },
    });
    expect(deep.response.status).toBe(200);
    expect(deep.payload.data).toMatchObject({
      mode: 'multi_space',
      stopReason: 'sufficient',
      usage: expect.objectContaining({
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      }),
    });
    expect((deep.payload.data.rounds as unknown[]).length).toBeGreaterThan(0);
  }, 120_000);

  it('rejects maxRounds=4 as a 400 knowledge validation problem', async () => {
    const response = await request('/v1/knowledge/search/deep', {
      method: 'POST',
      idempotencyKey: `s8-deep-invalid-${suffix}`,
      body: {
        knowledgeSpaceId: spaceId,
        knowledgeSpaceIds: [spaceId],
        query: 'refunds',
        tokenBudget: 12_000,
        maxRounds: 4,
        roundTokenBudget: 5_000,
      },
    });
    expect(response.response.status).toBe(400);
    expect(response.payload).toMatchObject({
      error: {
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        details: {
          issues: expect.arrayContaining([expect.objectContaining({ path: 'maxRounds' })]),
        },
      },
    });
  });

  it('L1-B12-MULTI-001-S01 rechecks current Source ACL before serving a previously issued preview URL', async () => {
    const preview = await request(`/v1/knowledge/files/${imageBlobRefId}/preview`, {
      method: 'POST',
      idempotencyKey: `b12-preview-revoke-${suffix}`,
      body: { ttlSeconds: 300 },
    });
    expect(preview.response.status, JSON.stringify(preview.payload)).toBe(200);
    const previewUrl = String(preview.payload.data.url);
    expect(previewUrl).not.toContain('objectKey');
    const cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
    const browser = await chromium.launch({ headless: true });
    const browserContext = await browser.newContext();
    await browserContext.addCookies([cookie]);
    const liveContent = await browserContext.request.get(previewUrl);
    expect(liveContent.status()).toBe(200);
    await connection.models.KnowledgeSource.updateOne(
      { workspaceId, _id: imageSourceId },
      { $set: { deletedAt: new Date() } },
    );
    try {
      const revokedContent = await browserContext.request.get(previewUrl);
      expect(revokedContent.status()).toBe(404);
      const revokedRetry = await request(`/v1/knowledge/files/${imageBlobRefId}/preview`, {
        method: 'POST',
        idempotencyKey: `b12-preview-revoke-retry-${suffix}`,
        body: { ttlSeconds: 300 },
      });
      expect(revokedRetry.response.status).toBe(404);
    } finally {
      await connection.models.KnowledgeSource.updateOne(
        { workspaceId, _id: imageSourceId },
        { $set: { deletedAt: null } },
      );
      await browserContext.close();
      await browser.close();
    }
  }, 120_000);

  it('L1-B12-MULTI-001-UI01 renders image import controls and the three index settings at three viewports', async () => {
    mkdirSync(screenshotDir, { recursive: true });
    const imageSources = await request(
      `/v1/knowledge/spaces/${spaceId}/sources?kind=image&limit=100`,
    );
    expect(imageSources.response.status).toBe(200);
    expect(imageSources.payload.data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: imageSourceId })]),
    );
    const cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
    const browser = await chromium.launch({ headless: true });
    const missingControls: string[] = [];
    const skipLinkFailures: string[] = [];
    try {
      for (const viewport of [
        { name: '360', width: 360, height: 900 },
        { name: '768', width: 768, height: 1_000 },
        { name: '1200', width: 1_200, height: 1_000 },
      ]) {
        const browserContext = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        await browserContext.addCookies([cookie]);
        const page = await browserContext.newPage();
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const failedRequests: string[] = [];
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text());
        });
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('requestfailed', (request) => {
          if (request.url().includes('/v1/knowledge/')) failedRequests.push(request.url());
        });

        await page.goto(
          `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=import&source=image`,
          { waitUntil: 'networkidle' },
        );
        await playwrightExpect(page.getByText('新建 / 导入', { exact: true })).toBeVisible();
        await playwrightExpect(
          page.getByRole('button', { name: /图片集合/ }).first(),
        ).toBeVisible();
        await page.getByRole('button', { name: /下一步/ }).click();
        await playwrightExpect(page.getByText('选择或拖放文件', { exact: false })).toBeVisible();

        const labels = ['标题加入索引', '自动生成补充索引', '图片自动索引'];
        const visibility = await Promise.all(
          labels.map((label) =>
            page
              .getByRole('checkbox', { name: label })
              .isVisible()
              .catch(() => false),
          ),
        );
        visibility.forEach((visible, index) => {
          if (!visible) missingControls.push(`${viewport.name}:${labels[index]}`);
        });

        const importOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(importOverflow).toBeLessThanOrEqual(0);
        const importAccessibility = await new AxeBuilder({ page }).analyze();
        expect(
          importAccessibility.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          ),
        ).toEqual([]);
        try {
          await assertSkipLinkDoesNotOverlap(page);
        } catch (error) {
          skipLinkFailures.push(
            `${viewport.name}:${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const importShot = await page.screenshot({
          fullPage: true,
          path: join(screenshotDir, `b12-image-import-${viewport.name}.png`),
        });
        writeFileSync(
          join(screenshotDir, `b12-image-import-${viewport.name}.sha256`),
          `${createHash('sha256').update(importShot).digest('hex')}\n`,
        );
        expect(consoleErrors).toEqual([]);
        expect(pageErrors).toEqual([]);
        expect(failedRequests).toEqual([]);
        await browserContext.close();
      }
    } finally {
      await browser.close();
    }
    expect(
      { missingControls, skipLinkFailures },
      'required B12 index switches or the accessible skip link are absent from the product import UI',
    ).toEqual({ missingControls: [], skipLinkFailures: [] });
  }, 240_000);

  it('L1-B12-SEARCH-006-UI01 runs pure-image product search and renders controlled results', async () => {
    mkdirSync(screenshotDir, { recursive: true });
    const cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
    const browser = await chromium.launch({ headless: true });
    const statuses: number[] = [];
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    const searchErrors: string[] = [];
    const skipLinkFailures: string[] = [];
    try {
      for (const viewport of [
        { name: '360', width: 360, height: 900 },
        { name: '768', width: 768, height: 1_000 },
        { name: '1200', width: 1_200, height: 1_000 },
      ]) {
        const browserContext = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        await browserContext.addCookies([cookie]);
        const page = await browserContext.newPage();
        page.on('console', (message) => {
          if (message.type() === 'error') {
            consoleErrors.push(`${viewport.name}:${message.text()}`);
          }
        });
        page.on('pageerror', (error) => pageErrors.push(`${viewport.name}:${error.message}`));
        page.on('requestfailed', (request) => {
          if (request.url().includes('/v1/knowledge/')) {
            failedRequests.push(`${viewport.name}:${request.url()}`);
          }
        });

        await page.goto(`${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=test`, {
          waitUntil: 'networkidle',
        });
        await playwrightExpect(
          page.getByRole('heading', { level: 2, name: '输入测试内容' }),
        ).toBeVisible();
        const uploadResponsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/v1/knowledge/uploads',
        );
        await page
          .locator('input[type="file"]')
          .setInputFiles(join(root, 'test/fixtures/s11/generated/s11-image-1x1.png'));
        const uploadResponse = await uploadResponsePromise;
        expect(uploadResponse.status()).toBe(201);
        const uploadedSession = (await uploadResponse.json()) as {
          data: { uploadId: string };
        };
        await playwrightExpect(page.getByRole('button', { name: '测试', exact: true })).toBeEnabled(
          {
            timeout: 30_000,
          },
        );
        const uploadedObject = await connection.models.KnowledgeObjectRef.findOne({
          workspaceId,
          _id: new connection.base.Types.ObjectId(uploadedSession.data.uploadId),
        }).lean<{
          purpose: string;
          state: string;
          createdByMemberId: string;
          knowledgeSpaceId: { toString(): string };
          expiresAt: Date | null;
        }>();
        expect(uploadedObject).toMatchObject({
          purpose: 'image',
          state: 'active',
          createdByMemberId: memberId,
        });
        expect(uploadedObject?.knowledgeSpaceId.toString()).toBe(spaceId);
        const responsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/v1/knowledge/search/image',
        );
        await page.getByRole('button', { name: '测试', exact: true }).click();
        const response = await responsePromise;
        statuses.push(response.status());
        if (!response.ok()) {
          const payload = await response.json().catch(() => null);
          searchErrors.push(`${viewport.name}:${JSON.stringify(payload)}`);
        }
        const searchShot = await page.screenshot({
          fullPage: true,
          path: join(screenshotDir, `b12-image-search-${viewport.name}.png`),
        });
        writeFileSync(
          join(screenshotDir, `b12-image-search-${viewport.name}.sha256`),
          `${createHash('sha256').update(searchShot).digest('hex')}\n`,
        );
        const searchOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(searchOverflow).toBeLessThanOrEqual(0);
        const searchAccessibility = await new AxeBuilder({ page }).analyze();
        expect(
          searchAccessibility.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          ),
        ).toEqual([]);
        try {
          await assertSkipLinkDoesNotOverlap(page);
        } catch (error) {
          skipLinkFailures.push(
            `${viewport.name}:${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await browserContext.close();
      }
    } finally {
      await browser.close();
    }
    expect({
      statuses,
      consoleErrors,
      pageErrors,
      failedRequests,
      searchErrors,
      skipLinkFailures,
    }).toEqual({
      statuses: [200, 200, 200],
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
      searchErrors: [],
      skipLinkFailures: [],
    });
  }, 240_000);
});
