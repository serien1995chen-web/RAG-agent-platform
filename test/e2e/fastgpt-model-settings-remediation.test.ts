import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHeaders, consoleCookie, startS4App, type S4AppHarness } from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_model_settings_${suffix}`;
const memberId = `mem_model_settings_${suffix}`;
const authToken = `model-settings-${suffix}`;
const resultDir = join(root, 'test-results', 'fastgpt-model-settings-remediation');
const profile = {
  models: [
    {
      id: 'qwen3.8-flash',
      displayName: 'Qwen3.8 Flash',
      provider: 'Qwen',
      type: 'llm',
      capabilities: ['chat', 'structured-output'],
      tags: [],
    },
    {
      id: 'qwen3.7-text-embedding',
      displayName: 'Qwen3.7 Text Embedding',
      provider: 'Qwen',
      type: 'embedding',
      capabilities: ['text-embedding', 'caption-embedding'],
      dimension: 1024,
      tags: ['多模态'],
    },
    {
      id: 'kimi-k2.5',
      displayName: 'Kimi K2.5',
      provider: 'MoonshotAI',
      type: 'llm',
      capabilities: ['chat', 'vision'],
      tags: [],
    },
    {
      id: 'glm-5v-turbo',
      displayName: 'GLM-5V Turbo',
      provider: 'ChatGLM',
      type: 'llm',
      capabilities: ['chat', 'vision'],
      tags: [],
    },
  ],
  defaults: {
    embedding: 'qwen3.7-text-embedding',
    textLLM: 'qwen3.8-flash',
    imageLLM: 'kimi-k2.5',
  },
};

let app: S4AppHarness;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let browser: Awaited<ReturnType<typeof chromium.launch>>;
let createdSpaceId: string | null = null;

async function api<T>(path: string, method: 'GET' | 'PUT' | 'DELETE' | 'POST', body?: unknown) {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...apiHeaders({
        authToken,
        workspaceId,
        ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }),
      }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json()) as {
    success?: boolean;
    data?: T;
    error?: { code?: string };
  };
  if (!response.ok || payload.success !== true) {
    throw new Error(`${method} ${path}: ${response.status} ${payload.error?.code ?? ''}`);
  }
  return payload.data as T;
}

beforeAll(async () => {
  const token = process.env.AIPROXY_API_TOKEN?.trim();
  if (!token) throw new Error('missing AIPROXY_API_TOKEN');
  process.env.KB_TEST_MONGO_URI ??=
    'mongodb://127.0.0.1:27017/kb_model_settings_remediation?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-local';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';
  app = await startS4App({
    suffix,
    workspaceId,
    memberId,
    authToken,
    externalModelMode: 'real',
    extraEnv: {
      AIPROXY_MODE: 'openai',
      AIPROXY_BASE_URL: 'https://tokendance.space/gateway/v1',
      AIPROXY_API_TOKEN: token,
      AIPROXY_MODEL_PROFILE_JSON: JSON.stringify(profile),
      S11_AIPROXY_MODEL_MAPPING_APPROVED: 'true',
    },
  });
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
  browser = await chromium.launch({ headless: true });
}, 240_000);

afterAll(async () => {
  if (createdSpaceId) {
    const current = await api<{ version: number; referenceRevision: number }>(
      `/v1/knowledge/spaces/${createdSpaceId}`,
      'GET',
    ).catch(() => null);
    if (current) {
      await api(`/v1/knowledge/spaces/${createdSpaceId}`, 'DELETE', {
        version: current.version,
        expectedReferenceRevision: current.referenceRevision,
        referenceStrategy: 'block',
      }).catch(() => undefined);
    }
  }
  await browser?.close();
  await app?.close();
}, 60_000);

describe('FastGPT model settings remediation', () => {
  it('persists workspace model settings and rejects stale versions', async () => {
    const environment = await api<{
      version: number;
      source: string;
      models: Array<Record<string, unknown>>;
      defaults: Record<string, string | null>;
    }>('/v1/knowledge/model-settings', 'GET');
    expect(environment.source).toBe('environment');
    expect(environment.version).toBe(0);
    const saved = await api<{ version: number; source: string }>(
      '/v1/knowledge/model-settings',
      'PUT',
      {
        version: environment.version,
        models: environment.models,
        defaults: environment.defaults,
      },
    );
    expect(saved).toMatchObject({ version: 1, source: 'database' });
    await expect(
      api('/v1/knowledge/model-settings', 'PUT', {
        version: 0,
        models: environment.models,
        defaults: environment.defaults,
      }),
    ).rejects.toThrow('KNOWLEDGE_CONFLICT');
  }, 120_000);

  it('creates with real text and visual LLM candidates and shows provider groups', async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    await page.goto(`${app.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await page.getByRole('menuitem', { name: /通用知识库/ }).click();
    const dialog = page.getByRole('dialog');
    await playwrightExpect(dialog.getByText('说明', { exact: true })).toHaveCount(0);
    await playwrightExpect(page.getByRole('button', { name: /文本理解模型/ })).toContainText(
      'Qwen3.8 Flash',
    );
    await playwrightExpect(page.getByRole('button', { name: /图片理解模型/ })).toContainText(
      'Kimi K2.5',
    );
    await page.getByRole('button', { name: /图片理解模型/ }).click();
    await playwrightExpect(page.getByText('MoonshotAI', { exact: true })).toBeVisible();
    await page.screenshot({ path: join(resultDir, 'model-selector.png'), fullPage: true });
    await page.getByRole('button', { name: /图片理解模型/ }).focus();
    await page.keyboard.press('Escape');

    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    await playwrightExpect(dialog.getByRole('textbox').first()).toBeFocused();
    await playwrightExpect(dialog.getByText('NETWORK_ERROR')).toHaveCount(0);

    const name = `模型槽位整改 ${suffix}`;
    await dialog.getByRole('textbox').first().fill(name);
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/v1/knowledge/spaces',
    );
    await dialog.getByRole('button', { name: '创建', exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const created = (await response.json()) as { data: { id: string } };
    createdSpaceId = created.data.id;
    await page.waitForURL(/\/dataset\/detail\?datasetId=/);
    const bindings = await api<{
      items: Array<{ modelType: string; modelId: string }>;
    }>(`/v1/knowledge/spaces/${createdSpaceId}/model-bindings`, 'GET');
    expect(bindings.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelType: 'llm', modelId: 'qwen3.8-flash' }),
        expect.objectContaining({ modelType: 'vlm', modelId: 'kimi-k2.5' }),
      ]),
    );
    await context.close();
  }, 180_000);

  it('renders the model settings page for workspace administrators', async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    await page.goto(`${app.baseUrl}/settings/models`, { waitUntil: 'networkidle' });
    await playwrightExpect(page.getByRole('heading', { level: 1, name: '模型配置' })).toBeVisible();
    await playwrightExpect(page.getByText('平台数据库', { exact: true })).toBeVisible();
    await playwrightExpect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible();
    await page.screenshot({ path: join(resultDir, 'model-settings-page.png'), fullPage: true });
    await context.close();
  });

  it('shows explicit empty and failed model catalog states', async () => {
    for (const state of ['empty', 'failed'] as const) {
      const context = await browser.newContext({
        viewport: { width: 1200, height: 900 },
        locale: 'zh-CN',
      });
      await context.addCookies([cookie]);
      const page = await context.newPage();
      await page.route('**/v1/knowledge/models?**', async (route) => {
        if (state === 'empty') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: {
                items: [],
                pageInfo: { nextCursor: null, hasMore: false },
                defaults: { embedding: null, textLLM: null, imageLLM: null },
                source: 'database',
              },
              traceId: `trace-${suffix}`,
              requestId: `request-${suffix}`,
            }),
          });
          return;
        }
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: {
              code: 'KNOWLEDGE_MODEL_FAILED',
              message: 'model failed',
              retryable: true,
            },
            traceId: `trace-${suffix}`,
            requestId: `request-${suffix}`,
          }),
        });
      });
      await page.goto(`${app.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '新建', exact: true }).click();
      await page.getByRole('menuitem', { name: /通用知识库/ }).click();
      const dialog = page.getByRole('dialog');
      if (state === 'empty') {
        await playwrightExpect(
          dialog.getByText('当前工作区没有可用模型，请管理员检查模型目录和默认模型配置。'),
        ).toBeVisible();
      } else {
        await playwrightExpect(dialog.getByText(/模型服务调用失败/)).toBeVisible();
        await playwrightExpect(dialog.getByRole('button', { name: '重试' })).toBeVisible();
      }
      await context.close();
    }
  });

  it('keeps the model selector inside 1200, 768 and 360 viewports', async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    await page.goto(`${app.baseUrl}/dataset/list`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await page.getByRole('menuitem', { name: /通用知识库/ }).click();
    for (const viewport of [
      { width: 1200, height: 900 },
      { width: 768, height: 1024 },
      { width: 360, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      const trigger = page.getByRole('button', { name: /文本理解模型/ });
      await trigger.focus();
      await page.keyboard.press('ArrowDown');
      const listbox = page.getByRole('listbox', { name: '文本理解模型' });
      await playwrightExpect(listbox).toBeVisible();
      const box = await listbox.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
      await page.keyboard.press('ArrowDown');
      await playwrightExpect(listbox.getByRole('option').first()).toBeFocused();
      await listbox.getByRole('option').last().scrollIntoViewIfNeeded();
      await playwrightExpect(listbox.getByRole('option').last()).toBeVisible();
      await page.keyboard.press('Escape');
      await playwrightExpect(trigger).toBeFocused();
      await playwrightExpect(listbox).toHaveCount(0);
      await trigger.click();
      await page.locator('body').click({ position: { x: 2, y: 2 } });
      await playwrightExpect(listbox).toHaveCount(0);
    }
    await context.close();
  });
});
