import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHeaders, consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const runId = process.env.B03A_RUN_ID ?? `b03a-${Date.now()}`;
const resultDir = join(root, 'test-results', 'b03a', runId, 'e2e');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_b03a_ui_${suffix}`;
const ownerMemberId = `mem_b03a_owner_${suffix}`;
const viewerMemberId = `mem_b03a_viewer_${suffix}`;
const ownerToken = `b03a-owner-${suffix}`;
const viewerToken = `b03a-viewer-${suffix}`;

let ownerApp: S4AppHarness;
let viewerApp: S4AppHarness;
let ownerCookie: Awaited<ReturnType<typeof consoleCookie>>;
let viewerCookie: Awaited<ReturnType<typeof consoleCookie>>;
let browser: Browser;

type ApiResult<T = Record<string, unknown>> = {
  status: number;
  payload: { success?: boolean; data?: T; error?: { code?: string } };
};

async function api<T = Record<string, unknown>>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<ApiResult<T>> {
  const response = await fetch(`${ownerApp.baseUrl}${path}`, {
    method,
    headers: {
      ...apiHeaders({
        authToken: ownerToken,
        workspaceId,
        idempotencyKey: method === 'GET' ? undefined : `b03a-${method}-${randomUUID()}`,
      }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, payload: (await response.json()) as ApiResult<T>['payload'] };
}

async function createSpace(name: string) {
  return api<{ id: string; version: number }>('/v1/knowledge/spaces', 'POST', {
    kind: 'space',
    parentSpaceId: null,
    name,
    description: `B03A UI ${name}`,
    iconKey: 'book-open',
    accessMode: 'workspace',
    sourceAclMode: 'enforced',
    sourcePermissionEnabled: true,
  });
}

async function createTextSource(spaceId: string, name: string) {
  return api<{ id: string; version: number; permissionRevision: number }>(
    `/v1/knowledge/spaces/${spaceId}/sources`,
    'POST',
    { kind: 'text', name },
  );
}

async function deleteSpace(spaceId: string) {
  const current = await api<{ version: number; referenceRevision: number }>(
    `/v1/knowledge/spaces/${spaceId}`,
    'GET',
  );
  if (current.status === 404 || !current.payload.data) return;
  await api(`/v1/knowledge/spaces/${spaceId}`, 'DELETE', {
    version: current.payload.data.version,
    expectedReferenceRevision: current.payload.data.referenceRevision ?? 0,
    referenceStrategy: 'block',
  });
}

async function newPage(cookie: Awaited<ReturnType<typeof consoleCookie>>) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
  });
  await context.addCookies([cookie]);
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  return { context, page, consoleErrors };
}

async function capture(testId: string, page: Page, runAssertions: () => Promise<void>) {
  try {
    await runAssertions();
  } finally {
    await page
      .screenshot({ path: join(resultDir, `${testId}.png`), fullPage: true })
      .catch(() => undefined);
  }
}

async function openSourcePermission(
  page: Page,
  spaceId: string,
  sourceName: string,
): Promise<void> {
  await page.goto(`${ownerApp.baseUrl}/dataset/detail?datasetId=${spaceId}`, {
    waitUntil: 'networkidle',
  });
  await page.getByRole('button', { name: `${sourceName} 的更多操作` }).click();
  await page.getByRole('menuitem', { name: 'Source 权限' }).click();
  await playwrightExpect(page.getByRole('dialog', { name: '权限配置' })).toBeVisible();
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_b03a_e2e?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-local';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';
  await mkdir(resultDir, { recursive: true });
  ownerApp = await startS4App({
    suffix: `b03a-owner-${suffix}`,
    workspaceId,
    memberId: ownerMemberId,
    authToken: ownerToken,
  });
  viewerApp = await startS4App({
    suffix: `b03a-viewer-${suffix}`,
    workspaceId,
    memberId: viewerMemberId,
    authToken: viewerToken,
    scopes: 'knowledge:read',
    isWorkspaceOwner: false,
  });
  ownerCookie = await consoleCookie({
    baseUrl: ownerApp.baseUrl,
    authToken: ownerToken,
    workspaceId,
  });
  viewerCookie = await consoleCookie({
    baseUrl: viewerApp.baseUrl,
    authToken: viewerToken,
    workspaceId,
  });
  browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await ownerApp?.close();
  await viewerApp?.close();
}, 60_000);

describe('B03A ACL and ownership desktop behavior', () => {
  it('L1-B03-COL-004-UI01 performs the complete Source ACL transition sequence', async () => {
    const { context, page, consoleErrors } = await newPage(ownerCookie);
    const name = `ACL UI ${suffix}`;
    const sourceName = `ACL source ${suffix}`;
    const space = await createSpace(name);
    const spaceId = space.payload.data?.id ?? '';
    const source = await createTextSource(spaceId, sourceName);
    expect(space.status).toBe(201);
    expect(source.status).toBe(201);
    try {
      await openSourcePermission(page, spaceId, sourceName);
      await capture('L1-B03-COL-004-UI01', page, async () => {
        for (const step of [
          { button: '启用 Source 权限', endpoint: 'enable', state: 'inherited / inherit' },
          {
            button: '解除继承',
            endpoint: 'detach',
            state: 'independent / override',
            confirm: true,
          },
          { button: '恢复继承', endpoint: 'resume-inherit', state: 'inherited / inherit' },
          {
            button: '关闭 Source 权限',
            endpoint: 'disable',
            state: 'disabled / inherit',
            confirm: true,
          },
        ]) {
          const response = page.waitForResponse(
            (item) =>
              item.request().method() === 'POST' &&
              new URL(item.url()).pathname ===
                `/v1/knowledge/sources/${source.payload.data?.id}/permissions/${step.endpoint}`,
          );
          await page.getByRole('button', { name: step.button }).click();
          if ('confirm' in step && step.confirm) {
            await page
              .getByRole('dialog', { name: '确认权限变更' })
              .getByRole('button', { name: '确认' })
              .click();
          }
          expect((await response).status(), step.button).toBe(200);
          await playwrightExpect(page.getByText(step.state, { exact: false })).toBeVisible();
        }
        expect(consoleErrors).toEqual([]);
      });
    } finally {
      await context.close();
      if (spaceId) await deleteSpace(spaceId);
    }
  });

  it('L1-B03-COL-004-UI02 keeps the permission dialog and shows a recoverable conflict', async () => {
    const { context, page } = await newPage(ownerCookie);
    const name = `ACL error UI ${suffix}`;
    const sourceName = `ACL error source ${suffix}`;
    const space = await createSpace(name);
    const spaceId = space.payload.data?.id ?? '';
    const source = await createTextSource(spaceId, sourceName);
    try {
      await openSourcePermission(page, spaceId, sourceName);
      await page.route(
        `**/v1/knowledge/sources/${source.payload.data?.id}/permissions/enable`,
        (route) =>
          route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({
              success: false,
              error: {
                code: 'KNOWLEDGE_CONFLICT',
                message: 'conflict',
                retryable: true,
                details: {},
              },
              traceId: `trace-b03a-${suffix}`,
              requestId: `request-b03a-${suffix}`,
            }),
          }),
      );
      await page.getByRole('button', { name: '启用 Source 权限' }).click();
      await capture('L1-B03-COL-004-UI02', page, async () => {
        const dialog = page.getByRole('dialog', { name: '权限配置' });
        await playwrightExpect(dialog).toBeVisible();
        await playwrightExpect(dialog.getByRole('alert')).toContainText(
          '数据已被其他操作更新，请刷新后重试。',
        );
      });
    } finally {
      await context.close();
      if (spaceId) await deleteSpace(spaceId);
    }
  });

  it('L1-B03-AUTH-002-UI01 hides management actions from a read-only collaborator', async () => {
    const { context, page } = await newPage(viewerCookie);
    const name = `Viewer hidden ${suffix}`;
    const space = await createSpace(name);
    const spaceId = space.payload.data?.id ?? '';
    await api(`/v1/knowledge/spaces/${spaceId}/collaborators`, 'POST', {
      memberId: viewerMemberId,
      role: 'read',
    });
    try {
      await page.goto(`${viewerApp.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
      await capture('L1-B03-AUTH-002-UI01', page, async () => {
        await playwrightExpect(page.getByText(name, { exact: true })).toBeVisible();
        await playwrightExpect(
          page.getByRole('button', { name: `${name} 的更多操作` }),
        ).toHaveCount(0);
      });
    } finally {
      await context.close();
      if (spaceId) await deleteSpace(spaceId);
    }
  });

  it('L1-B03-AUTH-004-UI01 transfers ownership and refreshes the visible owner', async () => {
    const { context, page } = await newPage(ownerCookie);
    const name = `Ownership UI ${suffix}`;
    const targetMemberId = `mem_b03a_target_${suffix}`;
    const space = await createSpace(name);
    const spaceId = space.payload.data?.id ?? '';
    await api(`/v1/knowledge/spaces/${spaceId}/collaborators`, 'POST', {
      memberId: targetMemberId,
      role: 'manage',
    });
    try {
      await page.goto(`${ownerApp.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: `${name} 的更多操作` }).click();
      await page.getByRole('menuitem', { name: '权限' }).click();
      await page.getByRole('button', { name: '转移所有权' }).click();
      await page.getByLabel('新所有者').selectOption(targetMemberId);
      const response = page.waitForResponse(
        (item) =>
          item.request().method() === 'POST' &&
          new URL(item.url()).pathname === `/v1/knowledge/spaces/${spaceId}/ownership-transfer`,
      );
      await page.getByRole('button', { name: '确认转移所有权' }).click();
      expect((await response).status()).toBe(200);
      await capture('L1-B03-AUTH-004-UI01', page, async () => {
        await playwrightExpect(
          page.locator('.kb2-kb-card__footer').getByText(targetMemberId, { exact: true }),
        ).toBeVisible();
      });
    } finally {
      await context.close();
      if (spaceId) await deleteSpace(spaceId);
    }
  });
});
