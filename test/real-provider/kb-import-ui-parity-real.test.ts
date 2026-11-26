import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startB06aApp, type B06aAppHarness } from '../e2e/b06a-harness';
import { apiHeaders, consoleCookie } from '../e2e/s4-app-harness';
import { requiredProviderEnv, writeProviderEvidence } from './s11-real-helpers';

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_kb_import_real_${suffix}`;
const memberId = `mem_kb_import_real_${suffix}`;
const authToken = `kb-import-real-${suffix}`;
const evidenceDir = process.env.S11_EVIDENCE_DIR?.trim();

let app: B06aAppHarness;
let browser: Awaited<ReturnType<typeof chromium.launch>>;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let spaceId = '';

function providerProfile() {
  const configured = process.env.AIPROXY_MODEL_PROFILE_JSON?.trim();
  const llmId = requiredProviderEnv('S11_AIPROXY_LLM_MODEL');
  const embeddingId = requiredProviderEnv('S11_AIPROXY_EMBEDDING_MODEL');
  const parsed = configured
    ? (JSON.parse(configured) as {
        models?: Array<Record<string, unknown>>;
        defaults?: Record<string, unknown>;
      })
    : { models: [] };
  const models = (parsed.models ?? []).map((model) => {
    const type = String(model.type ?? '');
    if (type === 'embedding') {
      return {
        ...model,
        limits: {
          maxToken: 4_096,
          defaultToken: 512,
          ...(model.limits as Record<string, unknown> | undefined),
        },
      };
    }
    if (type === 'llm') {
      return {
        ...model,
        limits: {
          maxContext: 32_000,
          maxResponse: 4_000,
          ...(model.limits as Record<string, unknown> | undefined),
        },
      };
    }
    return model;
  });
  if (!models.some((model) => model.id === llmId)) {
    models.push({
      id: llmId,
      type: 'llm',
      capabilities: ['chat'],
      limits: { maxContext: 32_000, maxResponse: 4_000 },
    });
  }
  if (!models.some((model) => model.id === embeddingId)) {
    models.push({
      id: embeddingId,
      type: 'embedding',
      capabilities: ['text-embedding', 'dimension:1024'],
      dimension: 1024,
      limits: { maxToken: 4_096, defaultToken: 512 },
    });
  }
  return {
    models,
    defaults: {
      embedding: embeddingId,
      textLLM: llmId,
    },
  };
}

async function api<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
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
    error?: { code?: string; message?: string };
  };
  if (!response.ok || payload.success !== true) {
    throw new Error(
      `${method} ${path}: ${response.status} ${payload.error?.code ?? ''} ${payload.error?.message ?? ''}`,
    );
  }
  return payload.data as T;
}

beforeAll(async () => {
  if (!evidenceDir) throw new Error('S11_EVIDENCE_DIR is required');
  process.env.KB_TEST_MONGO_URI ??= `mongodb://127.0.0.1:27017/kb_import_real_parity_${suffix}?replicaSet=rs0`;
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/14';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-test';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';

  app = await startB06aApp({
    suffix,
    workspaceId,
    memberId,
    authToken,
    withWorker: true,
    externalModelMode: 'real',
    extraEnv: {
      AIPROXY_MODE: 'openai',
      AIPROXY_BASE_URL: requiredProviderEnv('AIPROXY_BASE_URL'),
      AIPROXY_API_TOKEN: requiredProviderEnv('AIPROXY_API_TOKEN'),
      AIPROXY_MODEL_PROFILE_JSON: JSON.stringify(providerProfile()),
      S11_AIPROXY_MODEL_MAPPING_APPROVED: 'true',
    },
  });
  const space = await api<{ id: string }>('/v1/knowledge/spaces', 'POST', {
    kind: 'space',
    name: `真实模型导入验收-${suffix}`,
    accessMode: 'workspace',
    sourceAclMode: 'inherited',
    sourcePermissionEnabled: true,
  });
  spaceId = space.id;
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
  browser = await chromium.launch({ headless: true });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
});

describe('KB import UI parity through real LLM and embedding models', () => {
  it('submits QA paragraph settings and produces real QA segments', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const fileName = `kb-import-real-${suffix}.md`;
    try {
      await page.goto(
        `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=import&source=fileLocal`,
        { waitUntil: 'networkidle' },
      );
      await page.locator('input[type="file"]').setInputFiles({
        name: fileName,
        mimeType: 'text/markdown',
        buffer: Buffer.from(
          '退款申请需在购买后七天内提交。提交后客服会在两个工作日内审核，审核通过后原路退款。售后工单会保留处理记录。',
          'utf8',
        ),
      });
      await playwrightExpect(page.getByText('上传完成', { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await page.getByRole('button', { name: '下一步' }).click();
      await page.getByRole('radio', { name: /自定义设置数据处理规则/ }).check();
      await playwrightExpect(page.getByLabel('索引大小')).toBeVisible();
      await playwrightExpect(page.getByLabel('索引大小').locator('option')).toHaveCount(10);
      await page.getByRole('radio', { name: /问答对提取/ }).check();
      await playwrightExpect(page.getByLabel('最大分块大小')).toHaveValue('1000');
      await page.getByRole('button', { name: '模型识别段落' }).click();
      await page.getByRole('menuitem', { name: /强制处理/ }).click();
      await page.getByRole('button', { name: '下一步' }).click();
      await page.locator('.kb2-local-file-row').filter({ hasText: fileName }).click();
      await playwrightExpect(page.locator('.kb2-chunk-preview').first()).toBeVisible({
        timeout: 60_000,
      });
      await page.screenshot({ path: join(evidenceDir!, 'kb-import-real-preview.png') });
      await page.getByRole('button', { name: '下一步' }).last().click();
      await page.getByRole('button', { name: /开始上传/ }).click();

      const deadline = Date.now() + 360_000;
      let source:
        | {
            id: string;
            name: string;
            processingStatus: string;
          }
        | undefined;
      while (Date.now() < deadline) {
        const result = await api<{
          items: Array<{ id: string; name: string; processingStatus: string }>;
        }>(`/v1/knowledge/spaces/${spaceId}/sources?limit=100`, 'GET');
        source = result.items.find((item) => item.name === fileName);
        if (source && ['ready', 'partial', 'error'].includes(source.processingStatus)) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      }
      expect(source).toBeDefined();
      expect(
        ['ready', 'partial'],
        JSON.stringify({ source, appOutput: app.output().slice(-8_000) }),
      ).toContain(source!.processingStatus);
      const segments = await api<{
        items: Array<{ id: string; question: string; answer: string }>;
      }>(`/v1/knowledge/sources/${source!.id}/segments?limit=200`, 'GET');
      expect(segments.items.length).toBeGreaterThan(0);
      expect(
        segments.items.some(
          (segment) => segment.question.trim().length > 0 && segment.answer.trim().length > 0,
        ),
      ).toBe(true);
      await writeFile(
        join(evidenceDir!, 'kb-import-real-ui.json'),
        `${JSON.stringify(
          {
            status: 'REAL_VERIFIED',
            source,
            segmentCount: segments.items.length,
            qaSegmentCount: segments.items.filter(
              (segment) => segment.question.trim() && segment.answer.trim(),
            ).length,
          },
          null,
          2,
        )}\n`,
      );
      writeProviderEvidence('kb-import-real-ui-evidence.json', {
        status: 'REAL_VERIFIED',
        sourceStatus: source!.processingStatus,
        segmentCount: segments.items.length,
      });
    } finally {
      await context.close();
    }
  }, 420_000);
});
