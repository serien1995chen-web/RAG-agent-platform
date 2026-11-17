import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHeaders, consoleCookie, createSpace } from './s4-app-harness';
import { startB06aApp, type B06aAppHarness } from './b06a-harness';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b11_b_e2e_${suffix}`;
const memberId = `mem_b11_b_e2e_${suffix}`;
const authToken = `b11-b-e2e-token-${suffix}`;
const text = [
  '# 退款政策 Refund Policy',
  '',
  '退款申请会在五个工作日内处理。Refund requests are processed within five business days.',
  '',
  '| 项目 | 时限 |',
  '| --- | --- |',
  '| 审核 | 1 business day |',
  '| 退款 | 5 business days |',
  '',
  '短段。',
  '',
  '第二段包含中英文内容，用于验证预览与最终 Segment 的顺序和哈希。',
].join('\n');
const evidenceRoot = join(
  process.cwd(),
  'test-results',
  'b11',
  'b',
  process.env.B11_B_EVIDENCE_RUN_ID ?? 'b11-b-ad-hoc',
  'e2e',
);

let app: B06aAppHarness;
let spaceId = '';
let browser: Browser;
let connection: Awaited<ReturnType<typeof createKnowledgeMongoConnection>>;

interface JobView {
  jobId: string;
  status: string;
  progress: { stage?: string; completed?: number; total?: number; percent?: number };
  result: Record<string, unknown> | null;
  steps?: Array<{
    stepKey: string;
    externalEvidence?: Record<string, unknown> | null;
  }>;
}

interface PageView<T> {
  items: T[];
  pageInfo?: Record<string, unknown>;
}

function sleep(ms: number) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function api<T>(
  path: string,
  input: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<{ status: number; data: T; requestId: string }> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method: input.method ?? 'GET',
    headers: {
      ...apiHeaders({
        authToken,
        workspaceId,
        idempotencyKey: input.idempotencyKey,
      }),
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const payload = (await response.json()) as {
    success?: boolean;
    data?: T;
    problem?: { requestId?: string };
    requestId?: string;
  };
  if (!response.ok || payload.success !== true) {
    throw new Error(
      `${input.method ?? 'GET'} ${path} failed: ${response.status} ${JSON.stringify(payload)}`,
    );
  }
  return {
    status: response.status,
    data: payload.data as T,
    requestId: payload.problem?.requestId ?? payload.requestId ?? 'missing-request-id',
  };
}

async function setupModels() {
  const bindings = [
    {
      modelType: 'llm',
      modelId: 'mock-llm-general',
      displayName: 'Mock general LLM',
      requiredCapabilities: ['chat'],
      status: 'active',
    },
    {
      modelType: 'embedding',
      modelId: 'mock-embedding-768',
      displayName: 'Mock embedding 768',
      requiredCapabilities: ['dimension:768', 'text-embedding'],
      status: 'active',
    },
  ];
  await api(`/v1/knowledge/spaces/${spaceId}/model-bindings`, {
    method: 'PUT',
    idempotencyKey: `b11b-bind-${suffix}`,
    body: { bindings, version: 1 },
  });
}

async function waitForJob(jobId: string): Promise<JobView> {
  const deadline = Date.now() + 30_000;
  let waitingForChildrenSince: number | null = null;
  let latest: JobView | null = null;
  while (Date.now() < deadline) {
    const job = (await api<JobView>(`/v1/knowledge/jobs/${jobId}`)).data;
    latest = job;
    if (['succeeded', 'failed', 'cancelled', 'dead_letter'].includes(job.status)) {
      return job;
    }
    if (job.progress.stage === 'waiting_children') {
      waitingForChildrenSince ??= Date.now();
      if (Date.now() - waitingForChildrenSince >= 15_000) return job;
    }
    await sleep(400);
  }
  if (latest) return latest;
  throw new Error(`job ${jobId} could not be read`);
}

async function writeRecord(name: string, value: unknown) {
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(join(evidenceRoot, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function findSource(name: string) {
  const page = (
    await api<PageView<{ id: string; name: string; version: number }>>(
      `/v1/knowledge/spaces/${spaceId}/sources?limit=200`,
    )
  ).data;
  const source = page.items.find((item) => item.name === name);
  if (!source) throw new Error(`source ${name} not found`);
  return source;
}

async function inspectImport(input: { name: string; trainingType: 'chunk' | 'qa' }): Promise<{
  preview: {
    contentHash: string;
    totalChunks: number;
    chunks: Array<{ index: number; text: string; contentHash: string }>;
  };
  job: JobView;
  source: { id: string; name: string; version: number };
  segments: Array<{
    id: string;
    order: number;
    question: string;
    answer: string;
    content: string;
    version: number;
  }>;
}> {
  const chunking = {
    trainingType: input.trainingType,
    chunkSettingMode: 'custom',
    chunkTriggerType: 'minSize',
    chunkTriggerMinSize: 1,
    chunkSplitMode: 'size',
    chunkSize: 160,
  };
  const preview = (
    await api<{
      contentHash: string;
      totalChunks: number;
      chunks: Array<{ index: number; text: string; contentHash: string }>;
    }>(`/v1/knowledge/spaces/${spaceId}/imports/text`, {
      method: 'POST',
      idempotencyKey: `b11b-preview-${input.trainingType}-${suffix}`,
      body: {
        knowledgeSpaceId: spaceId,
        name: input.name,
        text,
        directoryId: null,
        chunking,
        dryRun: true,
      },
    })
  ).data;
  const idempotencyKey = `b11b-import-${input.trainingType}-${suffix}`;
  const submitted = (
    await api<{ jobId: string }>(`/v1/knowledge/spaces/${spaceId}/imports/text`, {
      method: 'POST',
      idempotencyKey,
      body: {
        knowledgeSpaceId: spaceId,
        name: input.name,
        text,
        directoryId: null,
        chunking,
        dryRun: false,
      },
    })
  ).data;
  const replay = (
    await api<{ jobId: string }>(`/v1/knowledge/spaces/${spaceId}/imports/text`, {
      method: 'POST',
      idempotencyKey,
      body: {
        knowledgeSpaceId: spaceId,
        name: input.name,
        text,
        directoryId: null,
        chunking,
        dryRun: false,
      },
    })
  ).data;
  expect(replay.jobId).toBe(submitted.jobId);
  const job = await waitForJob(submitted.jobId);
  const source = await findSource(input.name);
  const segments = (
    await api<
      PageView<{
        id: string;
        order: number;
        question: string;
        answer: string;
        content: string;
        version: number;
      }>
    >(`/v1/knowledge/sources/${source.id}/segments?limit=200&sort=order`)
  ).data.items;
  const models = registerKnowledgeModels(connection);
  const parseJobs = await models.KnowledgeJob.find({
    workspaceId,
    kind: 'parse',
    'inputSnapshot.sourceId': source.id,
  })
    .select({ _id: 1, status: 1, progress: 1, 'inputSnapshot.chunking': 1 })
    .lean();
  const steps = await models.KnowledgeJobStep.find({
    workspaceId,
    jobId: { $in: parseJobs.map((parseJob) => parseJob._id) },
  })
    .select({ stepKey: 1, externalEvidence: 1, status: 1 })
    .sort({ createdAt: 1 })
    .lean();
  return { preview, job: { ...job, steps }, source, segments, parseJobs };
}

async function capture(page: Page, name: string, network: unknown[], consoleErrors: string[]) {
  await mkdir(evidenceRoot, { recursive: true });
  await page.screenshot({ path: join(evidenceRoot, `${name}.png`), fullPage: true });
  await writeFile(
    join(evidenceRoot, `${name}.json`),
    `${JSON.stringify({ url: page.url(), viewport: page.viewportSize(), network, consoleErrors }, null, 2)}\n`,
  );
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_b11_b_e2e?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-local';
  app = await startB06aApp({ suffix, workspaceId, memberId, authToken });
  spaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
  connection = await createKnowledgeMongoConnection(
    process.env.KB_TEST_MONGO_URI ??
      'mongodb://127.0.0.1:27017/kb_b11_b_e2e?replicaSet=rs0&directConnection=true',
  );
  await setupModels();
  browser = await chromium.launch({ headless: true });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
    await connection.close();
  }
}, 60_000);

describe('L1-B11-B-PARSE-003/004 product chain', () => {
  it('L1-B11-B-PARSE-003-P01/S01 keeps API preview and final chunk Segment order/hash consistent', async () => {
    const result = await inspectImport({ name: `B11B chunk ${suffix}`, trainingType: 'chunk' });
    await writeRecord('parse-003-preview-segment', result);
    expect.soft(result.job.status).toBe('succeeded');
    expect
      .soft(result.preview.contentHash)
      .toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    expect.soft(result.preview.totalChunks).toBe(result.segments.length);
    expect
      .soft(result.segments.map((segment) => segment.order))
      .toEqual(result.segments.map((_, index) => index));
    expect
      .soft(result.segments.map((segment) => segment.content))
      .toEqual(result.preview.chunks.map((chunk) => chunk.text));
    expect
      .soft(result.segments.map((segment) => segment.content.trim()))
      .toEqual(result.preview.chunks.map((chunk) => chunk.text.trim()));
    for (const segment of result.segments) {
      expect.soft(segment.content.trim().length).toBeGreaterThan(0);
      expect.soft(segment).toHaveProperty('contentHash');
      expect.soft(segment).toHaveProperty('chunkSettingsHash');
    }
  });

  it('L1-B11-B-PARSE-004-F01 imports invalid mock QA as raw fallback without duplicate Segments', async () => {
    const result = await inspectImport({ name: `B11B qa ${suffix}`, trainingType: 'qa' });
    await writeRecord('parse-004-preview-segment', result);
    expect.soft(result.job.status).toBe('succeeded');
    expect.soft(result.segments.length).toBe(result.preview.totalChunks);
    expect.soft(result.segments.every((segment) => segment.question.trim().length > 0)).toBe(true);
    expect.soft(result.segments.every((segment) => segment.answer === '')).toBe(true);
    const persistStep = result.job.steps?.find((step) => step.stepKey === 'persist-segments');
    expect.soft(persistStep?.externalEvidence).toMatchObject({
      fallbackUsed: true,
      qaPromptVersion: 'qa.default@1',
      qaCount: result.segments.length,
    });
    expect
      .soft(result.job.steps?.filter((step) => step.stepKey === 'persist-segments'))
      .toHaveLength(1);
  });

  it('L1-B11-B-PARSE-003-UI01/UI02 shows full chunk/QA controls at 360/768/1200 and passes axe', async () => {
    const cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
    for (const viewport of [
      { width: 360, height: 900 },
      { width: 768, height: 900 },
      { width: 1200, height: 900 },
    ]) {
      const context = await browser.newContext({ viewport });
      await context.addCookies([cookie]);
      const page = await context.newPage();
      const network: Array<{ method: string; path: string; status: number }> = [];
      const consoleErrors: string[] = [];
      page.on('response', (response) => {
        network.push({
          method: response.request().method(),
          path: new URL(response.url()).pathname,
          status: response.status(),
        });
      });
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      try {
        await page.goto(`${app.baseUrl}/spaces/${spaceId}/import`, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: /自定义文本/ }).click();
        await page.getByRole('button', { name: '下一步' }).click();
        await playwrightExpect(page.getByLabel('名称')).toBeVisible();
        await playwrightExpect(page.getByLabel('文本内容')).toBeVisible();
        const missingControls: string[] = [];
        for (const name of [
          '训练类型',
          '切分方式',
          '分块条件',
          '段落 AI 模式',
          '最大段落深度',
          '最小分块长度',
          '分隔符',
          '重叠长度',
          '索引大小',
        ]) {
          const control = page.getByLabel(name, { exact: false });
          if ((await control.count()) === 0 || !(await control.first().isVisible())) {
            missingControls.push(name);
          }
        }
        expect.soft(missingControls, `${viewport.width}px missing controls`).toEqual([]);
        if (missingControls.length === 0) {
          await page.getByLabel('训练类型').selectOption('qa');
          await playwrightExpect(page.getByLabel(/QA Prompt/)).toBeVisible();
        }
        const dimensions = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect.soft(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
        const axe = await new AxeBuilder({ page }).analyze();
        expect
          .soft(
            axe.violations.filter(
              (violation) => violation.impact === 'serious' || violation.impact === 'critical',
            ),
          )
          .toEqual([]);
        expect.soft(consoleErrors).toEqual([]);
        await capture(page, `settings-${viewport.width}`, network, consoleErrors);
      } finally {
        await context.close();
      }
    }
  });
});
