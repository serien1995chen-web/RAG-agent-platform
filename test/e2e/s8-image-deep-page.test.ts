import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createKnowledgeConnections,
  KnowledgeFullTextRepository,
  KnowledgeJobExecutionRepository,
  KnowledgeObjectRefRepository,
  KnowledgeSegmentIndexRepository,
  KnowledgeVectorRepository,
  loadKnowledgeRuntimeConfig,
  registerKnowledgeModels,
  S06ProcessingApplication,
  S5MockModelCatalog,
  S6ProcessingRepository,
  S8CaptionApplication,
  S8FileTicketAdapter,
  S8ImageIndexRepository,
  S8ModelResolver,
  type KnowledgeConnections,
  type TenantContext,
} from '../../packages/service/src/index';
import { FileTicketService, MinioKnowledgeObjectStore } from '../../sdk/storage/src/index';
import {
  apiHeaders,
  consoleCookie,
  createSpace,
  startS4App,
  type S4AppHarness,
} from './s4-app-harness';

const root = resolve(import.meta.dirname, '../..');
const screenshotDir = process.env.S11_UI_EVIDENCE_DIR
  ? join(process.env.S11_UI_EVIDENCE_DIR, 's8-ui')
  : join(root, 'docs/acceptance/s8-ui');

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s8_e2e_${suffix}`;
const memberId = `mem_s8_e2e_${suffix}`;
const authToken = `kb-s8-e2e-token-${suffix}`;

let app: S4AppHarness;
let connections: KnowledgeConnections;
let connection: KnowledgeConnections['mongo'];
let pool: KnowledgeConnections['pg'];
let spaceId = '';
let textSourceId = '';
let textSegmentId = '';
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

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required e2e environment: ${name}`);
  return value;
}

async function request(
  path: string,
  input: {
    method?: 'GET' | 'POST';
    body?: unknown;
    idempotencyKey?: string;
  } = {},
) {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method: input.method ?? 'GET',
    headers: {
      ...apiHeaders({
        authToken,
        workspaceId,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      }),
      ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  return {
    response,
    payload: (await response.json()) as {
      success: boolean;
      data: Record<string, unknown>;
    },
  };
}

async function seedBindings() {
  const models = registerKnowledgeModels(connection);
  const now = new Date();
  await models.KnowledgeModelBinding.deleteMany({
    workspaceId,
    knowledgeSpaceId: new connection.base.Types.ObjectId(spaceId),
  });
  await models.KnowledgeModelBinding.create([
    {
      workspaceId,
      knowledgeSpaceId: new connection.base.Types.ObjectId(spaceId),
      version: 1,
      deletedAt: null,
      createdByMemberId: memberId,
      updatedByMemberId: memberId,
      modelType: 'llm',
      modelId: 'mock-llm-general',
      displayName: 'Mock LLM',
      requiredCapabilities: ['chat'],
      status: 'active',
      authorizedAt: now,
    },
    {
      workspaceId,
      knowledgeSpaceId: new connection.base.Types.ObjectId(spaceId),
      version: 1,
      deletedAt: null,
      createdByMemberId: memberId,
      updatedByMemberId: memberId,
      modelType: 'embedding',
      modelId: 'mock-embedding-768',
      displayName: 'Mock vision embedding',
      requiredCapabilities: ['text-embedding', 'vision', 'dimension:768'],
      status: 'active',
      authorizedAt: now,
    },
    {
      workspaceId,
      knowledgeSpaceId: new connection.base.Types.ObjectId(spaceId),
      version: 1,
      deletedAt: null,
      createdByMemberId: memberId,
      updatedByMemberId: memberId,
      modelType: 'vlm',
      modelId: 'mock-vlm',
      displayName: 'Mock VLM',
      requiredCapabilities: ['vision'],
      status: 'active',
      authorizedAt: now,
    },
  ]);
}

async function seedTextIndex(context: TenantContext) {
  const jobs = new KnowledgeJobExecutionRepository(connection);
  const catalog = new S5MockModelCatalog();
  const indexes = new KnowledgeSegmentIndexRepository(connection, jobs, catalog);
  await indexes.upsert(
    textSegmentId,
    {
      indexId: 'primary',
      type: 'custom',
      text: 'Refunds take five business days.',
      modelId: 'mock-embedding-768',
      version: 1,
    },
    'create',
    context,
  );
  const job = await connection.models.KnowledgeJob.findOne({
    workspaceId,
    kind: 'index',
    resourceId: textSegmentId,
  }).lean();
  const processor = new S06ProcessingApplication({
    jobs,
    store: new S6ProcessingRepository(connection),
    artifacts: {} as never,
    processing: {} as never,
    vectors: new KnowledgeVectorRepository(pool),
    fulltext: new KnowledgeFullTextRepository(connection),
    models: catalog,
    bindings: {
      async list() {
        return [
          {
            modelType: 'embedding',
            modelId: 'mock-embedding-768',
            displayName: 'Mock vision embedding',
            requiredCapabilities: ['text-embedding', 'vision', 'dimension:768'],
            status: 'active',
          },
        ];
      },
    },
    port: {
      async parse() {
        throw new Error('not used');
      },
      async embed() {
        return [Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0))];
      },
      async dispatchOutbox() {
        return true;
      },
    },
  });
  expect(
    await processor.handleQueue(
      'knowledge-index',
      String(job!._id),
      `s8-index-worker-${suffix}`,
      context,
    ),
  ).toBe('succeeded');
}

async function seedImage(context: TenantContext) {
  const models = registerKnowledgeModels(connection);
  const imageBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const source = await models.KnowledgeSource.create({
    workspaceId,
    knowledgeSpaceId: new connection.base.Types.ObjectId(spaceId),
    version: 2,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    kind: 'image',
    name: 'refund-flow.png',
    mimeType: 'image/png',
    sizeBytes: 128,
    contentHash: 'sha256',
    parseProvider: 'liteparse',
    processingStatus: 'queued',
    sourceVersion: 1,
    searchEnabled: true,
    permissionState: 'inherited',
    permissionRevision: 0,
    ownershipMemberId: memberId,
    metadata: {},
    tagValues: [],
  });
  imageSourceId = String(source._id);
  const object = new connection.base.Types.ObjectId();
  imageBlobRefId = String(object);
  await models.KnowledgeSource.updateOne(
    { workspaceId, _id: source._id },
    { $set: { blobRefId: object }, $inc: { version: 1 } },
  );
  const now = new Date();
  const objectKey = `ws/${workspaceId}/space/${spaceId}/source/${String(source._id)}/refund-flow.png`;
  await models.KnowledgeObjectRef.create({
    _id: object,
    workspaceId,
    knowledgeSpaceId: new connection.base.Types.ObjectId(spaceId),
    version: 2,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    provider: 'minio',
    bucket: requiredEnv('KB_TEST_S3_BUCKET'),
    objectKey,
    purpose: 'image',
    sourceId: source._id,
    mimeType: 'image/png',
    sizeBytes: imageBytes.byteLength,
    etag: 'etag',
    sha256: 'sha256',
    state: 'active',
    expiresAt: null,
    upload: {
      mode: 'single',
      status: 'completed',
      providerUploadId: null,
      pendingObjectKey: null,
      finalObjectKey: objectKey,
      finalizedAt: now,
      pendingUrlExpiresAt: null,
      partSizeBytes: imageBytes.byteLength,
      partCount: 1,
      parts: [],
      originalName: 'refund-flow.png',
      completedAt: now,
      abortedAt: null,
    },
  });
  const endpoint = new URL(requiredEnv('KB_TEST_S3_ENDPOINT'));
  const objectStore = new MinioKnowledgeObjectStore({
    provider: 'minio',
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey: requiredEnv('KB_TEST_S3_ACCESS_KEY'),
    secretKey: requiredEnv('KB_TEST_S3_SECRET_KEY'),
    region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
    bucket: requiredEnv('KB_TEST_S3_BUCKET'),
  });
  await objectStore.ensureBucket({
    workspaceId,
    knowledgeSpaceId: spaceId,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  await objectStore.putObject(
    {
      key: objectKey,
      body: imageBytes,
      sizeBytes: imageBytes.byteLength,
      contentType: 'image/png',
      workspaceId,
      knowledgeSpaceId: spaceId,
    },
    {
      workspaceId,
      knowledgeSpaceId: spaceId,
      requestId: context.requestId,
      traceId: context.traceId,
    },
  );
  const catalog = new S5MockModelCatalog();
  const indexes = new S8ImageIndexRepository(connection);
  const caption = new S8CaptionApplication({
    store: new S6ProcessingRepository(connection),
    objects: new KnowledgeObjectRefRepository(connection),
    models: new S8ModelResolver(connection, catalog),
    gateway: {
      async invoke<T>(request) {
        if (request.kind === 'vlm') {
          return {
            data: {
              choices: [
                {
                  message: {
                    content: JSON.stringify({ caption: 'Refund flow diagram' }),
                  },
                },
              ],
            } as T,
            actualModelId: request.modelId,
            attempts: 1,
            fallbackUsed: false,
            degraded: false,
            usage: { inputTokens: 2, outputTokens: 1, quantity: 3 },
          };
        }
        return {
          data: {
            data: Array.from({ length: request.input?.length ?? 0 }, (_, index) => ({
              index,
              embedding: Array.from({ length: 768 }, (_, vectorIndex) =>
                vectorIndex === index ? 1 : 0,
              ),
            })),
          } as T,
          actualModelId: request.modelId,
          attempts: 1,
          fallbackUsed: false,
          degraded: false,
          usage: { inputTokens: 2, outputTokens: 0, quantity: 2 },
        };
      },
    },
    tickets: new S8FileTicketAdapter(
      new FileTicketService(`s8-e2e-ticket-secret-${suffix}-at-least-32-bytes`, app.baseUrl),
    ),
    vectors: new KnowledgeVectorRepository(pool),
    fulltext: new KnowledgeFullTextRepository(connection),
    indexes,
  });
  await caption.execute(
    {
      _id: new connection.base.Types.ObjectId(),
      resourceId: imageSourceId,
      inputSnapshot: {
        sourceId: imageSourceId,
        sourceVersion: 1,
        imageBlobRefId,
      },
    } as never,
    context,
  );
}

beforeAll(async () => {
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  spaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
  const textSource = await request(`/v1/knowledge/spaces/${spaceId}/sources`, {
    method: 'POST',
    idempotencyKey: `s8-text-source-${suffix}`,
    body: {
      kind: 'text',
      name: `S8 refund ${suffix}`,
      searchEnabled: true,
      metadata: {},
    },
  });
  textSourceId = String(textSource.payload.data.id);
  const segment = await request(`/v1/knowledge/sources/${textSourceId}/segments`, {
    method: 'POST',
    idempotencyKey: `s8-text-segment-${suffix}`,
    body: {
      question: 'How long does a refund take?',
      answer: 'Refunds take five business days.',
      searchEnabled: true,
      metadata: { title: 'S8 refund policy' },
    },
  });
  textSegmentId = String(segment.payload.data.id);

  const config = loadKnowledgeRuntimeConfig({
    ...process.env,
    API_KEY_HMAC_SECRET_FILE: `${process.cwd()}/test/fixtures/s10/api-key-hmac.secret`,
    KB_MONGO_URI: requiredEnv('KB_TEST_MONGO_URI'),
    KB_REDIS_URL: requiredEnv('KB_TEST_REDIS_URL'),
    KB_PG_URL: requiredEnv('KB_TEST_PG_URL'),
    KB_S3_ENDPOINT: requiredEnv('KB_TEST_S3_ENDPOINT'),
    KB_S3_BUCKET: requiredEnv('KB_TEST_S3_BUCKET'),
    KB_S3_ACCESS_KEY_REF: 'env:KB_S8_E2E_S3_ACCESS',
    KB_S3_SECRET_KEY_REF: 'env:KB_S8_E2E_S3_SECRET',
  });
  connections = await createKnowledgeConnections(config);
  connection = connections.mongo;
  pool = connections.pg;
  const context: TenantContext = {
    workspaceId,
    memberId,
    requestId: `seed-s8-${suffix}`,
    traceId: suffix.padEnd(32, '0').slice(0, 32),
    scopes: ['knowledge:read', 'knowledge:write', 'knowledge:search'],
    isWorkspaceOwner: true,
  };
  await seedBindings();
  await seedTextIndex(context);
  await seedImage(context);
}, 240_000);

afterAll(async () => {
  const cleanupContext: TenantContext = {
    workspaceId,
    memberId,
    knowledgeSpaceId: spaceId,
    requestId: `cleanup-s8-${suffix}`,
    traceId: suffix.padEnd(32, '0').slice(0, 32),
    scopes: ['knowledge:read', 'knowledge:write'],
    isWorkspaceOwner: true,
  };
  if (process.env.KB_TEST_S3_ENDPOINT) {
    const endpoint = new URL(requiredEnv('KB_TEST_S3_ENDPOINT'));
    const objectStore = new MinioKnowledgeObjectStore({
      provider: 'minio',
      endPoint: endpoint.hostname,
      port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
      useSSL: endpoint.protocol === 'https:',
      accessKey: requiredEnv('KB_TEST_S3_ACCESS_KEY'),
      secretKey: requiredEnv('KB_TEST_S3_SECRET_KEY'),
      region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
      bucket: requiredEnv('KB_TEST_S3_BUCKET'),
    });
    const refs = connection
      ? await connection.models.KnowledgeObjectRef.find({ workspaceId }).lean()
      : [];
    const keys = new Set(
      refs.flatMap((ref: { objectKey?: string; upload?: { finalObjectKey?: string | null } }) =>
        [ref.objectKey, ref.upload?.finalObjectKey].filter(
          (key): key is string => typeof key === 'string' && key.length > 0,
        ),
      ),
    );
    for (const key of keys) {
      await objectStore.deleteObject(key, cleanupContext);
    }
  }
  if (connection) {
    for (const model of Object.values(registerKnowledgeModels(connection))) {
      await model.deleteMany({ workspaceId });
    }
  }
  if (pool) {
    for (const table of [
      'knowledge_segment_vectors_768',
      'knowledge_segment_vectors_1024',
      'knowledge_segment_vectors_1536',
      'knowledge_segment_vectors_3072',
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
    }
  }
  await connections?.close();
  await app?.close();
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
          page.getByRole('heading', { level: 2, name: '搜索测试' }),
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
        await playwrightExpect(page.getByRole('button', { name: '开始测试' })).toBeEnabled({
          timeout: 30_000,
        });
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
        await page.getByRole('button', { name: '开始测试' }).click();
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

  it('L1-B12-SEARCH-006-Q01 sustains 20 image-search QPS per workspace with p95 at or below 900 ms', async () => {
    const evidenceDir =
      process.env.B12_EVIDENCE_DIR ??
      join(root, 'test-results/b12', `unscoped-${randomUUID().slice(0, 8)}`);
    mkdirSync(evidenceDir, { recursive: true });
    const tempDir = mkdtempSync(join(tmpdir(), 'b12-image-k6-'));
    const uploadIdsFile = join(tempDir, 'upload-ids.json');
    writeFileSync(uploadIdsFile, `${JSON.stringify([imageBlobRefId])}\n`);
    const summaryPath = join(evidenceDir, 'b12-image-search-summary.json');
    const stderrPath = join(evidenceDir, 'b12-image-search-k6-stderr.log');
    const scriptPath = join(root, 'test/performance/k6/b12-image-search.js');
    const k6Binary = process.env.K6_BIN?.trim() || 'k6';
    const k6Version = spawnSync(k6Binary, ['version'], { encoding: 'utf8' });
    expect(k6Version.status, k6Version.stderr).toBe(0);
    const result = spawnSync(
      k6Binary,
      [
        'run',
        '--quiet',
        '--summary-export',
        summaryPath,
        '-e',
        `S11_PERF_BASE_URL=${app.baseUrl}`,
        '-e',
        `S11_PERF_WORKSPACE_ID=${workspaceId}`,
        '-e',
        `S11_PERF_SPACE_ID=${spaceId}`,
        '-e',
        `S11_PERF_API_KEY=${authToken}`,
        '-e',
        `S11_PERF_UPLOAD_IDS_FILE=${uploadIdsFile}`,
        '-e',
        'S11_PERF_QUERY=refund flow diagram',
        scriptPath,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      },
    );
    writeFileSync(stderrPath, String(result.stderr ?? ''));
    writeFileSync(join(evidenceDir, 'b12-image-search-app.log'), app.output());
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
      metrics: Record<string, { values?: Record<string, number>; count?: number }>;
    };
    const metricValues = (name: string) => {
      const metric = summary.metrics[name] ?? {};
      return metric.values ?? (metric as Record<string, number>);
    };
    const duration = metricValues('http_req_duration');
    const failed = metricValues('http_req_failed');
    const requests = metricValues('http_reqs');
    const errorRate = failed.rate ?? failed.value;
    const fixtureRoot = join(root, 'test/fixtures/b12');
    const fixtureHash = createHash('sha256');
    for (const name of readdirSync(fixtureRoot).sort()) {
      fixtureHash.update(name);
      fixtureHash.update(readFileSync(join(fixtureRoot, name)));
    }
    writeFileSync(
      join(evidenceDir, 'b12-image-search-meta.json'),
      `${JSON.stringify(
        {
          testId: 'L1-B12-SEARCH-006-Q01',
          candidateSha: process.env.CANDIDATE_SHA ?? 'faeb269018d949da1abf41b74be7d55f0762e7a6',
          k6: k6Version.stdout.trim().split('\n')[0],
          mode: 'deterministic-mock-models-real-infrastructure',
          quotaProfile: process.env.KB_QUOTA_PROFILE ?? 'free-v1',
          queryMode: 'mixed_text_and_image',
          workspaceId,
          spaceId,
          uploadIdCount: 1,
          fixtureHash: fixtureHash.digest('hex'),
          scenario: {
            executor: 'constant-arrival-rate',
            targetQps: 20,
            durationSeconds: process.env.S11_PERF_DURATION === '10s' ? 10 : 120,
            k6ExitCode: result.status,
            p95Ms: duration['p(95)'],
            errorRate,
            measuredQps: requests.rate,
            requestCount: requests.count,
            statusCounts: Object.fromEntries(
              Object.entries(summary.metrics)
                .filter(([name]) => name.startsWith('b12_status_'))
                .map(([name, metric]) => [name, metric.count ?? metric.values?.count ?? 0]),
            ),
            errorCodeCounts: Object.fromEntries(
              Object.entries(summary.metrics)
                .filter(([name]) => name.startsWith('b12_error_'))
                .map(([name, metric]) => [name, metric.count ?? metric.values?.count ?? 0]),
            ),
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(duration['p(95)']).toBeLessThanOrEqual(900);
    expect(errorRate).toBeLessThanOrEqual(0.01);
    expect(requests.rate).toBeGreaterThanOrEqual(18);
  }, 180_000);
});
