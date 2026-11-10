import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHeaders, consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const runId = 'b01-20261110-200118-257f501';
const resultDir = join(root, 'test-results', 'b01', runId, 'e2e');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_b01_ui_${suffix}`;
const ownerMemberId = `mem_b01_owner_${suffix}`;
const viewerMemberId = `mem_b01_viewer_${suffix}`;
const ownerToken = `b01-owner-${suffix}`;
const viewerToken = `b01-viewer-${suffix}`;

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
  token = ownerToken,
): Promise<ApiResult<T>> {
  const response = await fetch(`${ownerApp.baseUrl}${path}`, {
    method,
    headers: {
      ...apiHeaders({
        authToken: token,
        workspaceId,
        idempotencyKey: method === 'GET' ? undefined : `b01-${method}-${randomUUID()}`,
      }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, payload: (await response.json()) as ApiResult<T>['payload'] };
}

async function createSpace(
  name: string,
  kind: 'space' | 'folder' = 'space',
  parentSpaceId?: string,
) {
  const result = await api<{ id: string; version: number }>('/v1/knowledge/spaces', 'POST', {
    kind,
    parentSpaceId: parentSpaceId ?? null,
    name,
    description: `B01 UI ${name}`,
    iconKey: kind === 'folder' ? 'folder' : 'book-open',
    accessMode: 'workspace',
    sourceAclMode: kind === 'folder' ? 'inherited' : 'enforced',
    sourcePermissionEnabled: true,
  });
  return result;
}

async function deleteSpace(spaceId: string) {
  const current = await api<{ version: number; referenceRevision: number }>(
    `/v1/knowledge/spaces/${spaceId}`,
    'GET',
  );
  if (current.status === 404 || !current.payload.data) return;
  await api(`/v1/knowledge/spaces/${spaceId}`, 'DELETE', {
    version: current.payload.data.version,
    expectedReferenceRevision: current.payload.data.referenceRevision,
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
  const failedRequests: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
    );
  });
  return { context, page, consoleErrors, failedRequests };
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

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_product_list?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-local';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';
  await mkdir(resultDir, { recursive: true });
  ownerApp = await startS4App({
    suffix: `owner-${suffix}`,
    workspaceId,
    memberId: ownerMemberId,
    authToken: ownerToken,
  });
  viewerApp = await startS4App({
    suffix: `viewer-${suffix}`,
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

describe('B01 lifecycle desktop behavior', () => {
  it('L1-B01-KB-001-UI01 creates, edits, refreshes and deletes a knowledge space', async () => {
    const { context, page, consoleErrors } = await newPage(ownerCookie);
    let createdId = '';
    const name = `桌面生命周期 ${suffix}`;
    try {
      await page.goto(`${ownerApp.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '新建' }).click();
      await page.getByRole('menuitem', { name: /通用知识库/ }).click();
      const input = page.locator('#kb2-create-form input').first();
      await playwrightExpect(input).toBeFocused();
      await input.fill(name);
      const responsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/v1/knowledge/spaces',
      );
      await page.getByRole('button', { name: '创建', exact: true }).click();
      const response = await responsePromise;
      expect(response.status()).toBe(201);
      const payload = (await response.json()) as { data: { id: string } };
      createdId = payload.data.id;
      await page.waitForURL(/\/dataset\/detail\?datasetId=/);
      await playwrightExpect(page.getByRole('heading', { level: 1, name })).toBeVisible();

      await page.getByRole('button', { name: '我的知识库' }).click();
      await page.waitForURL('**/dataset/list');
      await page.getByRole('button', { name: `${name} 的更多操作` }).click();
      await page.getByRole('menuitem', { name: '编辑信息' }).click();
      const renamed = `${name} 已更新`;
      await page.locator('#kb2-edit-form input').first().fill(renamed);
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await playwrightExpect(page.getByText(renamed, { exact: true })).toBeVisible();
      await page.reload({ waitUntil: 'networkidle' });
      await playwrightExpect(page.getByText(renamed, { exact: true })).toBeVisible();

      await page.getByRole('button', { name: `${renamed} 的更多操作` }).click();
      await page.getByRole('menuitem', { name: '删除' }).click();
      await page.getByLabel('资源名称').fill(renamed);
      await page.getByRole('button', { name: '确认删除' }).click();
      await playwrightExpect(page.getByText(renamed, { exact: true })).toHaveCount(0);
      createdId = '';
      const accessibility = await new AxeBuilder({ page }).analyze();
      await capture('L1-B01-KB-001-UI01', page, async () => {
        expect(
          accessibility.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          ),
        ).toEqual([]);
        expect(consoleErrors).toEqual([]);
      });
    } finally {
      if (createdId) await deleteSpace(createdId);
      await context.close();
    }
  });

  it('L1-B01-KB-001-N02 limits the create-name entry to 30 characters', async () => {
    const { context, page } = await newPage(ownerCookie);
    try {
      await page.goto(`${ownerApp.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '新建' }).click();
      await page.getByRole('menuitem', { name: /通用知识库/ }).click();
      const input = page.locator('#kb2-create-form input').first();
      await input.fill('a'.repeat(35));
      await capture('L1-B01-KB-001-N02', page, async () => {
        expect((await input.inputValue()).length).toBe(30);
      });
    } finally {
      await context.close();
    }
  });

  it('L1-B01-KB-001-N01 keeps sibling duplicate names as two independent cards', async () => {
    const { context, page } = await newPage(ownerCookie);
    const name = `UI same sibling ${suffix}`;
    const first = await createSpace(name);
    const second = await createSpace(name);
    try {
      await page.goto(`${ownerApp.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
      await capture('L1-B01-KB-001-N01', page, async () => {
        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(first.payload.data?.id).not.toBe(second.payload.data?.id);
        await playwrightExpect(page.getByText(name, { exact: true })).toHaveCount(2);
      });
    } finally {
      if (first.payload.data?.id) await deleteSpace(first.payload.data.id);
      if (second.payload.data?.id) await deleteSpace(second.payload.data.id);
      await context.close();
    }
  });

  it('L1-B01-KB-001-C02 replays the same create idempotency key as one resource', async () => {
    const name = `幂等创建 ${suffix}`;
    const key = `b01-create-idempotency-${suffix}`;
    const body = {
      kind: 'space',
      parentSpaceId: null,
      name,
      description: 'same request',
      iconKey: 'book-open',
      accessMode: 'workspace',
      sourceAclMode: 'inherited',
      sourcePermissionEnabled: true,
    };
    const execute = () =>
      fetch(`${ownerApp.baseUrl}/v1/knowledge/spaces`, {
        method: 'POST',
        headers: {
          ...apiHeaders({ authToken: ownerToken, workspaceId, idempotencyKey: key }),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    let createdId = '';
    try {
      const first = await execute();
      const firstBody = (await first.json()) as { data: { id: string } };
      const second = await execute();
      const secondBody = (await second.json()) as { data: { id: string } };
      createdId = firstBody.data.id;
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(secondBody.data.id).toBe(firstBody.data.id);
      const listed = await api<{ items: Array<{ id: string; name: string }> }>(
        '/v1/knowledge/spaces?limit=100',
        'GET',
      );
      expect(listed.payload.data?.items.filter((item) => item.name === name)).toHaveLength(1);
    } finally {
      if (createdId) await deleteSpace(createdId);
    }
  });

  it('L1-B01-KB-001-F01 replays a delete request without creating a second delete Job', async () => {
    const created = await createSpace(`删除重放 ${suffix}`);
    const id = created.payload.data?.id ?? '';
    const current = await api<{ version: number; referenceRevision: number }>(
      `/v1/knowledge/spaces/${id}`,
      'GET',
    );
    const key = `b01-delete-idempotency-${suffix}`;
    const body = {
      version: current.payload.data?.version,
      expectedReferenceRevision: current.payload.data?.referenceRevision,
      referenceStrategy: 'block',
    };
    const execute = () =>
      fetch(`${ownerApp.baseUrl}/v1/knowledge/spaces/${id}`, {
        method: 'DELETE',
        headers: {
          ...apiHeaders({ authToken: ownerToken, workspaceId, idempotencyKey: key }),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    const first = await execute();
    const firstBody = (await first.json()) as { data: { jobId: string } };
    const second = await execute();
    const secondBody = (await second.json()) as { data: { jobId: string } };
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(secondBody.data.jobId).toBe(firstBody.data.jobId);
    const jobs = await api<{ items: Array<{ kind: string; resourceId: string }> }>(
      `/v1/knowledge/jobs?limit=100&resourceId=${encodeURIComponent(id)}`,
      'GET',
    );
    expect(
      jobs.payload.data?.items.filter((job) => job.kind === 'delete' && job.resourceId === id),
    ).toHaveLength(1);
  });

  it('L1-B01-KB-002-UI01 persists legal model settings', async () => {
    const { context, page } = await newPage(ownerCookie);
    const created = await createSpace(`模型配置 ${suffix}`);
    const id = created.payload.data?.id ?? '';
    try {
      await page.goto(`${ownerApp.baseUrl}/dataset/detail?datasetId=${id}`, {
        waitUntil: 'networkidle',
      });
      await playwrightExpect(page.getByRole('complementary', { name: '知识库信息' })).toBeVisible();
      await page.getByRole('button', { name: '编辑模型配置' }).click();
      const modelSelects = page.locator('.kb2-modal select');
      await modelSelects.nth(0).selectOption({ index: 1 });
      await modelSelects.nth(1).selectOption({ index: 1 });
      await page.getByRole('button', { name: '保存' }).click();
      await page.reload({ waitUntil: 'networkidle' });
      await capture('L1-B01-KB-002-UI01', page, async () => {
        await playwrightExpect(page.getByText('后端未提供')).toHaveCount(0);
      });
    } finally {
      if (id) await deleteSpace(id);
      await context.close();
    }
  });

  it('L1-B01-KB-002-N01 exposes authorized creation model defaults', async () => {
    const { context, page } = await newPage(ownerCookie);
    const created = await createSpace(`默认模型 ${suffix}`);
    const id = created.payload.data?.id ?? '';
    try {
      await page.goto(`${ownerApp.baseUrl}/dataset/detail?datasetId=${id}`, {
        waitUntil: 'networkidle',
      });
      await capture('L1-B01-KB-002-N01-defaults', page, async () => {
        await playwrightExpect(page.getByText('后端未提供')).toHaveCount(0);
      });
    } finally {
      if (id) await deleteSpace(id);
      await context.close();
    }
  });

  it('L1-B01-KB-003-UI01 exposes the ownership transfer entry', async () => {
    const { context, page } = await newPage(ownerCookie);
    const created = await createSpace(`所有权入口 ${suffix}`);
    const id = created.payload.data?.id ?? '';
    try {
      await page.goto(`${ownerApp.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: `所有权入口 ${suffix} 的更多操作` }).click();
      await page.getByRole('menuitem', { name: '权限' }).click();
      await capture('L1-B01-KB-003-UI01-ownership', page, async () => {
        await playwrightExpect(page.getByRole('button', { name: '转移所有权' })).toBeVisible();
      });
    } finally {
      if (id) await deleteSpace(id);
      await context.close();
    }
  });

  it('L1-B01-KB-003-UI01 reports batch partial success and keeps failed items selected', async () => {
    const { context, page } = await newPage(ownerCookie);
    const first = await createSpace(`批量成功 ${suffix}`);
    const second = await createSpace(`批量失败 ${suffix}`);
    const firstId = first.payload.data?.id ?? '';
    const secondId = second.payload.data?.id ?? '';
    try {
      await page.goto(`${ownerApp.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
      await page.route('**/v1/knowledge/spaces/batch-actions', async (route) => {
        await deleteSpace(firstId);
        await route.fulfill({
          status: 207,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              code: 'KNOWLEDGE_PARTIAL_SUCCESS',
              requested: 2,
              succeeded: 1,
              failed: 1,
              items: [
                { id: firstId, success: true, version: 2 },
                { id: secondId, success: false, code: 'KNOWLEDGE_CONFLICT' },
              ],
            },
            requestId: `request-b01-partial-${suffix}`,
            traceId: `trace-b01-partial-${suffix}`.padEnd(32, '0').slice(0, 32),
          }),
        });
      });
      await page.getByRole('button', { name: '批量管理' }).click();
      await page.getByRole('checkbox', { name: `选择 批量成功 ${suffix}` }).check();
      await page.getByRole('checkbox', { name: `选择 批量失败 ${suffix}` }).check();
      await page.getByRole('button', { name: '批量删除' }).click();
      await page.getByLabel('确认文本').fill('确认删除');
      await page.getByRole('button', { name: '确认删除' }).click();
      await playwrightExpect(page.getByText(/成功 1 项，失败 1/)).toBeVisible();
      await capture('L1-B01-KB-003-UI01-partial', page, async () => {
        await playwrightExpect(page.locator('.kb2-modal')).toHaveCount(0);
        await playwrightExpect(
          page.locator('.kb2-kb-card').filter({ hasText: `批量成功 ${suffix}` }),
        ).toHaveCount(0);
        await playwrightExpect(
          page.locator('.kb2-kb-card').filter({ hasText: `批量失败 ${suffix}` }),
        ).toHaveCount(1);
        await playwrightExpect(
          page.getByRole('checkbox', { name: `选择 批量失败 ${suffix}` }),
        ).toBeChecked();
      });
    } finally {
      if (firstId) await deleteSpace(firstId);
      if (secondId) await deleteSpace(secondId);
      await context.close();
    }
  });

  it('L1-B01-KB-003-UI02 receives a usable export ticket or downloadable object', async () => {
    const { context, page } = await newPage(ownerCookie);
    const created = await createSpace(`导出票据 ${suffix}`);
    const id = created.payload.data?.id ?? '';
    try {
      await page.goto(`${ownerApp.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: `导出票据 ${suffix} 的更多操作` }).click();
      const responsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `/v1/knowledge/spaces/${id}/exports`,
      );
      await page.getByRole('menuitem', { name: '导出' }).click();
      const response = await responsePromise;
      const payload = (await response.json()) as {
        data: { jobId?: string; status?: string; url?: string; ticketId?: string };
      };
      await capture('L1-B01-KB-003-UI02-export', page, async () => {
        expect(response.status()).toBe(202);
        expect(payload.data).toMatchObject({ status: 'queued' });
        expect(payload.data.url ?? payload.data.ticketId).toEqual(expect.any(String));
      });
    } finally {
      if (id) await deleteSpace(id);
      await context.close();
    }
  });

  it('L1-B01-KB-003-UI03 confirms drag movement and refreshes the target folder', async () => {
    const { context, page } = await newPage(ownerCookie);
    const folder = await createSpace(`拖放目标 ${suffix}`, 'folder');
    const folderId = folder.payload.data?.id ?? '';
    const child = await createSpace(`拖放资源 ${suffix}`, 'space', folderId);
    const childId = child.payload.data?.id ?? '';

    await api(`/v1/knowledge/spaces/${childId}/move`, 'POST', {
      targetParentId: null,
      version: child.payload.data?.version,
    });
    try {
      await page.goto(`${ownerApp.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
      const sourceCard = page.locator('.kb2-kb-card').filter({ hasText: `拖放资源 ${suffix}` });
      const targetCard = page.locator('.kb2-kb-card').filter({ hasText: `拖放目标 ${suffix}` });
      await sourceCard.dragTo(targetCard);
      await playwrightExpect(page.getByRole('dialog', { name: /确认移动/ })).toBeVisible();
      await playwrightExpect(page.getByText(/继承目标文件夹的访问权限/)).toBeVisible();
      await page.getByRole('button', { name: '取消' }).click();
      await page.getByRole('button', { name: `拖放目标 ${suffix} 文件夹` }).click();
      await page.waitForURL(`**/dataset/list?parentId=${folderId}`);
      await playwrightExpect(page.getByText(`拖放资源 ${suffix}`, { exact: true })).toHaveCount(0);
      await page.goBack({ waitUntil: 'networkidle' });
      await page
        .locator('.kb2-kb-card')
        .filter({ hasText: `拖放资源 ${suffix}` })
        .dragTo(page.locator('.kb2-kb-card').filter({ hasText: `拖放目标 ${suffix}` }));
      await page.getByRole('button', { name: '确认移动' }).click();
      await page.getByRole('button', { name: `拖放目标 ${suffix} 文件夹` }).click();
      await page.waitForURL(`**/dataset/list?parentId=${folderId}`);
      await capture('L1-B01-KB-003-UI03-drag', page, async () => {
        await playwrightExpect(page.getByText(`拖放资源 ${suffix}`, { exact: true })).toBeVisible();
      });
    } finally {
      if (childId) await deleteSpace(childId);
      if (folderId) await deleteSpace(folderId);
      await context.close();
    }
  });

  it('L1-B01-KB-001-A01 hides create controls from a read-only workspace member', async () => {
    const { context, page } = await newPage(viewerCookie);
    try {
      await page.goto(`${viewerApp.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
      await capture('L1-B01-KB-001-A01', page, async () => {
        await playwrightExpect(page.getByRole('button', { name: '新建' })).toHaveCount(0);
      });
    } finally {
      await context.close();
    }
  });
});
