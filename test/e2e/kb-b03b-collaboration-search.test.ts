import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openB03BHarness, type B03BHarness } from '../fixtures/b03b/harness';
import { apiHeaders, consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const runId = process.env.B03B_RUN_ID ?? '20261111-185947';
const resultDir = join(root, 'test-results', 'b03b', runId, 'ui');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_b03b_e2e_${suffix}`;
const memberId = `mem_b03b_e2e_${suffix}`;
const authToken = `kb-b03b-e2e-${suffix}`;

let app: S4AppHarness;
let harness: B03BHarness;
let browser: Browser;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let spaceId = '';
let spaceVersion = 1;
let referenceRevision = 0;
let foreignSpaceId = '';

async function api<T = Record<string, unknown>>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...apiHeaders({
        authToken,
        workspaceId,
        idempotencyKey: method === 'GET' ? undefined : `b03b-${suffix}-${randomUUID()}`,
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
    throw Object.assign(
      new Error(`${method} ${path} failed: ${response.status} ${payload.error?.code ?? ''}`),
      { status: response.status, code: payload.error?.code },
    );
  }
  return payload.data as T;
}

async function pageWithCookie(
  width = 1440,
  height = 900,
): Promise<{
  page: Page;
  close(): Promise<void>;
}> {
  const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN' });
  await context.addCookies([cookie]);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  return { page, close: () => context.close() };
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_test?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-test';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';
  harness = await openB03BHarness(`e2e${suffix}`);
  foreignSpaceId = (await harness.createSpace(harness.ownerB)).id;
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
  browser = await chromium.launch({ headless: true });
  await mkdir(resultDir, { recursive: true });

  const space = await api<{ id: string; version: number; referenceRevision: number }>(
    '/v1/knowledge/spaces',
    'POST',
    {
      kind: 'space',
      parentSpaceId: null,
      name: `B03B 协作者知识库 ${suffix}`,
      description: 'B03B tenant collaboration search validation',
      iconKey: 'book-open',
      accessMode: 'restricted',
      sourceAclMode: 'inherited',
      sourcePermissionEnabled: true,
    },
  );
  spaceId = space.id;
  spaceVersion = space.version;
  referenceRevision = space.referenceRevision;
  await api(`/v1/knowledge/spaces/${spaceId}/sources`, 'POST', {
    kind: 'text',
    name: `B03B 可见 Source ${suffix}`,
    searchEnabled: true,
    metadata: {},
  });
}, 180_000);

afterAll(async () => {
  if (app && spaceId) {
    await api(`/v1/knowledge/spaces/${spaceId}`, 'DELETE', {
      version: spaceVersion,
      expectedReferenceRevision: referenceRevision,
      referenceStrategy: 'block',
    }).catch(() => undefined);
  }
  await browser?.close();
  await app?.close();
  if (harness) {
    for (const model of Object.values(harness.models)) {
      await model.deleteMany({ workspaceId });
    }
  }
  await harness?.cleanup();
}, 60_000);

describe('L1 B03B desktop tenant, collaborator and search authorization', () => {
  it('L1-B03-AUTH-003-P02 Owner 通过 API 添加协作者且 Info 权限弹窗刷新显示角色', async () => {
    const collaboratorMemberId = `mem_b03b_collaborator_${suffix}`;
    const created = await api<{ memberId: string; role: string; version: number }>(
      `/v1/knowledge/spaces/${spaceId}/collaborators`,
      'POST',
      { memberId: collaboratorMemberId, role: 'read' },
    );
    expect(created).toMatchObject({
      memberId: collaboratorMemberId,
      role: 'read',
      version: 1,
    });
    const updated = await api<{ memberId: string; role: string; version: number }>(
      `/v1/knowledge/spaces/${spaceId}/collaborators/${encodeURIComponent(collaboratorMemberId)}`,
      'PATCH',
      { role: 'write', version: created.version },
    );
    expect(updated).toMatchObject({ memberId: collaboratorMemberId, role: 'write' });
    await api(`/v1/knowledge/resources/space/${spaceId}/acl`, 'GET');

    const { page, close } = await pageWithCookie();
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.goto(`${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=info`, {
      waitUntil: 'networkidle',
    });
    await playwrightExpect(
      page.getByRole('heading', { level: 1, name: `B03B 协作者知识库 ${suffix}` }),
    ).toBeVisible();
    await page.getByRole('button', { name: '管理知识库权限' }).click();
    const dialog = page.getByRole('dialog', { name: '权限配置' });
    await playwrightExpect(dialog).toBeVisible();
    await playwrightExpect(
      dialog.getByText(collaboratorMemberId, { exact: true }).first(),
    ).toBeVisible();
    await playwrightExpect(dialog.getByText('write', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: join(resultDir, 'b03b-auth003-p02.png'), fullPage: true });
    expect(consoleErrors).toEqual([]);
    await close();
  });

  it('L1-B03-AUTH-001-A01 路径直访跨 Workspace 知识库不显示资源内容', async () => {
    const { page, close } = await pageWithCookie();
    await page.goto(`${app.baseUrl}/dataset/detail?datasetId=${foreignSpaceId}&currentTab=info`, {
      waitUntil: 'networkidle',
    });
    await playwrightExpect(
      page.getByRole('heading', { level: 1, name: `B03B space e2e${suffix}` }),
    ).toHaveCount(0);
    await page.screenshot({ path: join(resultDir, 'b03b-auth001-a01.png'), fullPage: true });
    await close();
    await expect(api(`/v1/knowledge/spaces/${foreignSpaceId}`, 'GET')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('L1-B03-AUTH-003-N04 未知 Workspace 成员不能作为协作者写入', async () => {
    await expect(
      api(`/v1/knowledge/spaces/${spaceId}/collaborators`, 'POST', {
        memberId: `mem_b03b_unknown_${suffix}`,
        role: 'read',
      }),
    ).rejects.toMatchObject({
      status: expect.any(Number),
      code: 'KNOWLEDGE_VALIDATION_FAILED',
    });
  });

  it('L1-B03-AUTH-001-Q01 跨租户错误响应和页面不泄露 object key 或成员存在性', async () => {
    const error = await api(`/v1/knowledge/spaces/${foreignSpaceId}/sources`, 'POST', {
      kind: 'text',
      name: 'cross tenant probe',
      metadata: {},
    }).catch((caught) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    const safe = JSON.stringify(error);
    expect(safe).not.toContain('objectKey');
    expect(safe).not.toContain('mem_b03b_owner_b');
    await writeFile(
      join(resultDir, 'b03b-cross-tenant-error.json'),
      JSON.stringify({ status: (error as { status?: number }).status, safe }, null, 2),
    );
  });
});
