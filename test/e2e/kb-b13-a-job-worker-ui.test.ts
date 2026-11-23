import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiHeaders,
  consoleCookie,
  createSpace,
  startS4App,
  type S4AppHarness,
} from './s4-app-harness';
import { registerKnowledgeModels } from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeConnections } from '../../packages/service/src/shared/runtime/knowledge-connections';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_b13a_e2e_${suffix}`;
const memberId = `mem_b13a_e2e_${suffix}`;
const authToken = `kb-b13a-e2e-token-${suffix}`;
const root = resolve(import.meta.dirname, '../..');
const resultDir = join(
  root,
  'test-results',
  'b13a',
  process.env.B13A_RUN_ID ?? `b13a-ui-${suffix}`,
  'e2e',
);

let app: S4AppHarness;
let browser: Browser;
let connections: Awaited<ReturnType<typeof createKnowledgeConnections>>;
let spaceId = '';
let sourceId = '';
let segmentId = '';

async function request(
  path: string,
  input: {
    method?: 'GET' | 'POST';
    body?: unknown;
    idempotencyKey?: string;
    token?: string;
  } = {},
) {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method: input.method ?? 'GET',
    headers: {
      ...apiHeaders({
        authToken: input.token ?? authToken,
        workspaceId,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      }),
      ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    data?: unknown;
    error?: { code?: string };
    problem?: { error?: { code?: string } };
  };
  return { response, payload };
}

function jobBody(kind: string) {
  const base = {
    kind,
    resourceType: 'segment',
    resourceId: segmentId,
    inputSnapshot: { segmentVersion: 1, modelId: 'mock-embedding-1024' },
    priority: 5,
  };
  if (kind === 'parse') {
    return {
      ...base,
      resourceType: 'source',
      resourceId: sourceId,
      inputSnapshot: { sourceVersion: 1, parseProvider: 'liteparse', configHash: 'cfg' },
    };
  }
  if (kind === 'segment') {
    return {
      ...base,
      inputSnapshot: { rawTextBlobId: segmentId, sourceVersion: 1, chunking: { mode: 'auto' } },
    };
  }
  if (kind === 'qa') {
    return {
      ...base,
      inputSnapshot: {
        segmentInputs: [segmentId],
        modelId: 'mock-qa',
        promptVersion: 'v1',
        sourceVersion: 1,
      },
    };
  }
  if (kind === 'rebuild') {
    return {
      ...base,
      resourceType: 'space',
      resourceId: spaceId,
      inputSnapshot: { sourceIds: [sourceId], reason: 'manual' },
    };
  }
  return base;
}

async function createJob(kind: string, key: string) {
  return request('/v1/knowledge/jobs', {
    method: 'POST',
    idempotencyKey: `b13a-e2e-${suffix}-${key}`,
    body: jobBody(kind),
  });
}

beforeAll(async () => {
  await mkdir(resultDir, { recursive: true });
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  connections = await createKnowledgeConnections({
    environment: 'test',
    workerMode: 'http',
    port: 3010,
    instanceId: `b13a-e2e-fixture-${suffix}`,
    mongoUri: process.env.KB_TEST_MONGO_URI,
    redisUrl: process.env.KB_TEST_REDIS_URL,
    pgUrl: process.env.KB_TEST_PG_URL,
    s3: {
      endpoint: process.env.KB_TEST_S3_ENDPOINT,
      region: process.env.KB_TEST_S3_REGION,
      bucket: process.env.KB_TEST_S3_BUCKET,
      accessKeyRef: 'env:KB_B13A_E2E_ACCESS',
      secretKeyRef: 'env:KB_B13A_E2E_SECRET',
    },
    auth: {
      mode: 'mock',
      fixture: {
        token: authToken,
        workspaceId,
        memberId,
        scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
        isWorkspaceOwner: true,
      },
    },
    externalModes: { model: 'mock', ocr: 'mock', connector: 'mock' },
    logLevel: 'error',
  });
  browser = await chromium.launch({ headless: true });
  spaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
  const source = await request(`/v1/knowledge/spaces/${spaceId}/sources`, {
    method: 'POST',
    idempotencyKey: `b13a-e2e-source-${suffix}`,
    body: { kind: 'text', name: `B13A ${suffix}`, searchEnabled: true, metadata: {} },
  });
  expect(source.response.status).toBe(201);
  sourceId = String((source.payload.data as { id: string }).id);
  const segment = await request(`/v1/knowledge/sources/${sourceId}/segments`, {
    method: 'POST',
    idempotencyKey: `b13a-e2e-segment-${suffix}`,
    body: { question: 'Refund?', answer: 'Five days.', searchEnabled: true, metadata: {} },
  });
  expect(segment.response.status).toBe(201);
  segmentId = String((segment.payload.data as { id: string }).id);
}, 180_000);

afterAll(async () => {
  await app?.close();
  if (connections) {
    for (const model of Object.values(registerKnowledgeModels(connections.mongo))) {
      await model.deleteMany({ workspaceId });
    }
    await connections.close();
  }
  await browser?.close();
});

describe('B13-A Job API and UI', () => {
  it('L1-B13-A-TRAIN-001-P01 creates all seven public job kinds with queued state', async () => {
    for (const kind of ['parse', 'segment', 'qa', 'embed', 'index', 'fulltext', 'rebuild']) {
      const created = await createJob(kind, kind);
      expect(created.response.status, kind).toBe(202);
      const job = created.payload.data as {
        jobId: string;
        kind: string;
        status: string;
        attempts: number;
        maxAttempts: number;
        version: number;
        steps: unknown[];
      };
      expect(job.jobId).toMatch(/^[a-f0-9]{24}$/);
      expect(job.kind).toBe(kind);
      expect(job.status).toBe('queued');
      expect(job.attempts).toBe(0);
      expect(job.maxAttempts).toBe(3);
      expect(job.version).toBe(1);
      expect(Array.isArray(job.steps)).toBe(true);
      const read = await request(`/v1/knowledge/jobs/${job.jobId}`);
      expect(read.response.status).toBe(200);
      expect((read.payload.data as { status: string }).status).toBe('queued');
    }
  });

  it('L1-B13-A-TRAIN-001-N01 rejects unknown kind and mismatched resourceType with 400', async () => {
    const unknown = await request('/v1/knowledge/jobs', {
      method: 'POST',
      idempotencyKey: `b13a-e2e-unknown-${suffix}`,
      body: { ...jobBody('index'), kind: 'not-a-job' },
    });
    expect(unknown.response.status).toBe(400);
    expect(unknown.payload.problem?.error?.code ?? unknown.payload.error?.code).toBe(
      'KNOWLEDGE_VALIDATION_FAILED',
    );
    const mismatch = await request('/v1/knowledge/jobs', {
      method: 'POST',
      idempotencyKey: `b13a-e2e-mismatch-${suffix}`,
      body: { ...jobBody('index'), resourceType: 'space', resourceId: spaceId },
    });
    expect(mismatch.response.status).toBe(400);
  });

  it('L1-B13-A-TRAIN-001-N02 rejects invalid ids, unknown resources and cross-space rebuild sources', async () => {
    const invalid = await request('/v1/knowledge/jobs', {
      method: 'POST',
      idempotencyKey: `b13a-e2e-invalid-${suffix}`,
      body: { ...jobBody('index'), resourceId: 'not-an-object-id' },
    });
    expect(invalid.response.status).toBe(400);
    const missing = await request('/v1/knowledge/jobs', {
      method: 'POST',
      idempotencyKey: `b13a-e2e-missing-${suffix}`,
      body: { ...jobBody('index'), resourceId: '0123456789abcdef01234567' },
    });
    expect(missing.response.status).toBe(404);
    const otherSpace = await createSpace({
      baseUrl: app.baseUrl,
      authToken,
      workspaceId,
      suffix: `${suffix}x`,
    });
    const cross = await request('/v1/knowledge/jobs', {
      method: 'POST',
      idempotencyKey: `b13a-e2e-cross-${suffix}`,
      body: {
        kind: 'rebuild',
        resourceType: 'space',
        resourceId: otherSpace,
        inputSnapshot: { sourceIds: [sourceId], reason: 'manual' },
      },
    });
    expect([400, 404]).toContain(cross.response.status);
  });

  it('L1-B13-A-TRAIN-001-N03 rejects malformed snapshots, extra fields and invalid priority', async () => {
    const badPriority = await request('/v1/knowledge/jobs', {
      method: 'POST',
      idempotencyKey: `b13a-e2e-priority-${suffix}`,
      body: { ...jobBody('index'), priority: 99 },
    });
    expect(badPriority.response.status).toBe(400);
    const extra = await request('/v1/knowledge/jobs', {
      method: 'POST',
      idempotencyKey: `b13a-e2e-extra-${suffix}`,
      body: { ...jobBody('index'), unknownField: true },
    });
    expect(extra.response.status).toBe(400);
    const badSnapshot = await request('/v1/knowledge/jobs', {
      method: 'POST',
      idempotencyKey: `b13a-e2e-snapshot-${suffix}`,
      body: { ...jobBody('index'), inputSnapshot: { segmentVersion: 1, workspaceId } },
    });
    expect(badSnapshot.response.status).toBe(400);
  });

  it('L1-B13-A-TRAIN-001-N04 reuses the same idempotency key and rejects a different body', async () => {
    const body = jobBody('index');
    const first = await request('/v1/knowledge/jobs', {
      method: 'POST',
      idempotencyKey: `b13a-e2e-idem-${suffix}`,
      body,
    });
    const replay = await request('/v1/knowledge/jobs', {
      method: 'POST',
      idempotencyKey: `b13a-e2e-idem-${suffix}`,
      body,
    });
    expect(first.response.status).toBe(202);
    expect(replay.response.status).toBe(202);
    expect((replay.payload.data as { jobId: string }).jobId).toBe(
      (first.payload.data as { jobId: string }).jobId,
    );
    const conflict = await request('/v1/knowledge/jobs', {
      method: 'POST',
      idempotencyKey: `b13a-e2e-idem-${suffix}`,
      body: { ...body, inputSnapshot: { segmentVersion: 2, modelId: 'mock-embedding-1024' } },
    });
    expect(conflict.response.status).toBe(409);
  });

  it('L1-B13-A-TRAIN-001-N04 rejects a request body over the 10 MiB API limit with 413', async () => {
    const response = await fetch(`${app.baseUrl}/v1/knowledge/jobs`, {
      method: 'POST',
      headers: {
        ...apiHeaders({ authToken, workspaceId, idempotencyKey: `b13a-e2e-large-${suffix}` }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'index',
        resourceType: 'segment',
        resourceId: segmentId,
        inputSnapshot: { segmentVersion: 1, padding: 'x'.repeat(10 * 1024 * 1024 + 1) },
        priority: 5,
      }),
    });
    expect(response.status).toBe(413);
  });

  it('L1-B13-A-TRAIN-001-A01 rejects a read-only caller before creating a Job', async () => {
    const readToken = `kb-b13a-read-token-${suffix}`;
    const readonlyApp = await startS4App({
      suffix: `${suffix}-ro`,
      workspaceId,
      memberId,
      authToken: readToken,
      scopes: 'knowledge:read',
    });
    try {
      const response = await fetch(`${readonlyApp.baseUrl}/v1/knowledge/jobs`, {
        method: 'POST',
        headers: {
          ...apiHeaders({
            authToken: readToken,
            workspaceId,
            idempotencyKey: `b13a-e2e-readonly-${suffix}`,
          }),
          'content-type': 'application/json',
        },
        body: JSON.stringify(jobBody('index')),
      });
      expect(response.status).toBe(403);
    } finally {
      await readonlyApp.close();
    }
  });

  it('L1-B13-A-TRAIN-001-S05 projects a newly queued parse Job onto the Source processing state', async () => {
    const source = await request(`/v1/knowledge/spaces/${spaceId}/sources`, {
      method: 'POST',
      idempotencyKey: `b13a-e2e-projection-source-${suffix}`,
      body: {
        kind: 'text',
        name: `B13A projection ${suffix}`,
        searchEnabled: true,
        metadata: {},
      },
    });
    expect(source.response.status).toBe(201);
    const projectionSourceId = String((source.payload.data as { id: string }).id);
    const created = await request('/v1/knowledge/jobs', {
      method: 'POST',
      idempotencyKey: `b13a-e2e-projection-job-${suffix}`,
      body: {
        kind: 'parse',
        resourceType: 'source',
        resourceId: projectionSourceId,
        inputSnapshot: { sourceVersion: 1, parseProvider: 'liteparse', configHash: 'cfg' },
        priority: 5,
      },
    });
    expect(created.response.status).toBe(202);
    expect((created.payload.data as { status: string }).status).toBe('queued');
    const projected = await request(`/v1/knowledge/sources/${projectionSourceId}`);
    expect(projected.response.status).toBe(200);
    expect((projected.payload.data as { processingStatus: string }).processingStatus).toMatch(
      /^(queued|parsing)$/,
    );
  });

  it('L1-B13-A-TRAIN-001-UI02 submits a text import, shows queued progress and restores it after refresh', async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([
      await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId }),
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    try {
      await page.goto(
        `${app.baseUrl}/dataset/detail?datasetId=${spaceId}&currentTab=import&source=fileCustom`,
        { waitUntil: 'networkidle' },
      );
      await page.getByRole('button', { name: '下一步' }).click();
      await page.getByLabel('名称').fill(`B13A import ${suffix}`);
      await page.getByLabel('文本内容').fill('B13A import refresh and queued status.');
      await page.getByRole('button', { name: '下一步' }).click();
      await page.getByRole('button', { name: '下一步' }).click();
      await playwrightExpect(page.getByText('分块数量', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '下一步' }).click();
      const submitted = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().endsWith(`/spaces/${spaceId}/imports/text`),
      );
      await page.getByRole('button', { name: '确认导入' }).click();
      expect((await submitted).status()).toBe(202);
      await playwrightExpect(page.getByText('任务 ID')).toBeVisible();
      await playwrightExpect(page.getByText('等待处理').first()).toBeVisible();
      const jobId = new URL(page.url()).searchParams.get('importJobId');
      expect(jobId).toMatch(/^[a-f0-9]{24}$/);

      await page.reload({ waitUntil: 'networkidle' });
      await playwrightExpect(page.getByText(jobId!, { exact: true })).toBeVisible();
      await playwrightExpect(page.getByText('等待处理').first()).toBeVisible();
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(
        accessibility.violations.filter(
          (violation) => violation.impact === 'serious' || violation.impact === 'critical',
        ),
      ).toEqual([]);
      await page.screenshot({
        path: join(resultDir, 'L1-B13-A-TRAIN-001-UI02.png'),
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  });

  it('L1-B13-A-TRAIN-001-UI01 exposes the Jobs task center with status and progress', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    await context.addCookies([
      await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId }),
    ]);
    const page = await context.newPage();
    try {
      const response = await page.goto(`${app.baseUrl}/spaces/${spaceId}/jobs`, {
        waitUntil: 'networkidle',
      });
      expect(response?.status()).toBe(200);
      await playwrightExpect(page.getByRole('heading', { name: '任务中心' })).toBeVisible();
      await playwrightExpect(page.getByLabel('任务概览')).toBeVisible();
      await playwrightExpect(page.getByLabel('任务列表')).toBeVisible();
      const accessibility = await new AxeBuilder({ page }).analyze();
      expect(
        accessibility.violations.filter(
          (violation) => violation.impact === 'serious' || violation.impact === 'critical',
        ),
      ).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
