import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect as playwrightExpect } from '@playwright/test';
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
const screenshotDir = join(root, 'docs/acceptance/s8-ui');

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
      indexId: 'default',
      type: 'default',
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
    expect(image.response.status).toBe(200);
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

  it('renders real Images and Deep pages and rechecks ticket ACL on content', async () => {
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

        await page.goto(`${app.baseUrl}/spaces/${spaceId}/images`, {
          waitUntil: 'networkidle',
        });
        await playwrightExpect(
          page.getByRole('heading', { level: 1, name: '图片知识' }),
        ).toBeVisible();
        await playwrightExpect(
          page.getByText('refund-flow.png', { exact: false }).first(),
        ).toBeVisible();
        await page.getByRole('button', { name: '预览' }).first().click();
        await playwrightExpect(page.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await playwrightExpect(page.getByRole('dialog')).toHaveCount(0);
        const imagesOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(imagesOverflow).toBeLessThanOrEqual(0);
        const imagesAccessibility = await new AxeBuilder({ page }).analyze();
        expect(
          imagesAccessibility.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          ),
        ).toEqual([]);
        const imagesShot = await page.screenshot({
          fullPage: true,
          path: join(screenshotDir, `s8-images-${viewport.name}.png`),
        });
        writeFileSync(
          join(screenshotDir, `s8-images-${viewport.name}.sha256`),
          `${createHash('sha256').update(imagesShot).digest('hex')}\n`,
        );

        await page.goto(
          `${app.baseUrl}/spaces/${spaceId}/search?mode=deep&query=refunds&budget=12000`,
          { waitUntil: 'networkidle' },
        );
        await playwrightExpect(
          page.getByRole('heading', { level: 1, name: '深度检索' }),
        ).toBeVisible();
        const deepResponsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/v1/knowledge/search/deep',
        );
        await page.getByRole('button', { name: '运行深度检索' }).click();
        const deepResponse = await deepResponsePromise;
        expect(deepResponse.status(), await deepResponse.text()).toBe(200);
        await playwrightExpect(page.getByText('停止原因:', { exact: false })).toBeVisible({
          timeout: 20_000,
        });
        const deepOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(deepOverflow).toBeLessThanOrEqual(0);
        const deepAccessibility = await new AxeBuilder({ page }).analyze();
        expect(
          deepAccessibility.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          ),
        ).toEqual([]);
        const deepShot = await page.screenshot({
          fullPage: true,
          path: join(screenshotDir, `s8-deep-${viewport.name}.png`),
        });
        writeFileSync(
          join(screenshotDir, `s8-deep-${viewport.name}.sha256`),
          `${createHash('sha256').update(deepShot).digest('hex')}\n`,
        );
        expect(consoleErrors).toEqual([]);
        expect(pageErrors).toEqual([]);
        expect(failedRequests).toEqual([]);
        await browserContext.close();
      }
    } finally {
      await browser.close();
    }

    const preview = await request(`/v1/knowledge/files/${imageBlobRefId}/preview`, {
      method: 'POST',
      idempotencyKey: `s8-preview-revoke-${suffix}`,
      body: { ttlSeconds: 300 },
    });
    expect(preview.response.status).toBe(200);
    const previewUrl = String(preview.payload.data.url);
    await connection.models.KnowledgeSource.updateOne(
      { workspaceId, _id: imageSourceId },
      { $set: { deletedAt: new Date() } },
    );
    try {
      const revokedContent = await fetch(previewUrl);
      expect(revokedContent.status).toBe(404);
      const revokedRetry = await request(`/v1/knowledge/files/${imageBlobRefId}/preview`, {
        method: 'POST',
        idempotencyKey: `s8-preview-revoke-retry-${suffix}`,
        body: { ttlSeconds: 300 },
      });
      expect(revokedRetry.response.status).toBe(404);
    } finally {
      await connection.models.KnowledgeSource.updateOne(
        { workspaceId, _id: imageSourceId },
        { $set: { deletedAt: null } },
      );
    }
  }, 240_000);
});
