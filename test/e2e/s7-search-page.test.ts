import { randomUUID } from 'node:crypto';
import { chromium, expect as playwrightExpect } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createKnowledgeConnections,
  KnowledgeFullTextRepository,
  KnowledgeJobExecutionRepository,
  KnowledgeSegmentIndexRepository,
  KnowledgeVectorRepository,
  loadKnowledgeRuntimeConfig,
  S06ProcessingApplication,
  S5MockModelCatalog,
  S5ProcessingApplication,
  S6ProcessingRepository,
  registerKnowledgeModels,
  type KnowledgeConnections,
  type TenantContext,
} from '../../packages/service/src/index';
import { S7DownstreamKnowledgeClient } from '../../packages/web/src/client/s7-downstream-knowledge-client';
import {
  AgentSemanticConsumer,
  ChatHybridConsumer,
  WorkflowMultiConsumer,
} from './s7-consumer-fixtures';
import {
  apiHeaders,
  consoleCookie,
  createSpace,
  startS4App,
  verifyResponsivePage,
  type S4AppHarness,
} from './s4-app-harness';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s7_e2e_${suffix}`;
const memberId = `mem_s7_e2e_${suffix}`;
const authToken = `kb-s7-e2e-token-${suffix}`;

let app: S4AppHarness;
let connections: KnowledgeConnections;
let connection: KnowledgeConnections['mongo'];
let pool: KnowledgeConnections['pg'];
let spaceId = '';
let secondSpaceId = '';
let sourceId = '';
let segmentId = '';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required e2e environment: ${name}`);
  return value;
}

async function request(
  path: string,
  input: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
  const payload = (await response.json()) as {
    success: boolean;
    data?: unknown;
    error?: unknown;
  };
  return { response, payload };
}

async function seedS6Index(tenant: TenantContext) {
  const models = registerKnowledgeModels(connection);
  await models.KnowledgeModelBinding.create({
    workspaceId,
    knowledgeSpaceId: new connection.base.Types.ObjectId(spaceId),
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    modelType: 'embedding',
    modelId: 'mock-embedding-768',
    displayName: 'Mock embedding 768',
    requiredCapabilities: ['text-embedding', 'dimension:768'],
    status: 'active',
    authorizedAt: new Date(),
  });
  const jobs = new KnowledgeJobExecutionRepository(connection);
  const catalog = new S5MockModelCatalog();
  const indexes = new KnowledgeSegmentIndexRepository(connection, jobs, catalog);
  await indexes.upsert(
    segmentId,
    {
      indexId: 'default',
      type: 'default',
      text: 'Refunds take five business days.',
      modelId: 'mock-embedding-768',
      version: 1,
    },
    'create',
    tenant,
  );
  const job = await models.KnowledgeJob.findOne({
    workspaceId,
    kind: 'index',
    resourceId: segmentId,
  }).lean();
  expect(job).toBeTruthy();
  const processing = new S06ProcessingApplication({
    jobs,
    store: new S6ProcessingRepository(connection),
    artifacts: {
      async materialize() {
        throw new Error('not used by index fixture');
      },
    },
    processing: new S5ProcessingApplication(),
    vectors: new KnowledgeVectorRepository(pool),
    fulltext: new KnowledgeFullTextRepository(connection),
    models: catalog,
    bindings: {
      async list() {
        return [
          {
            modelType: 'embedding',
            modelId: 'mock-embedding-768',
            displayName: 'Mock embedding 768',
            requiredCapabilities: ['text-embedding', 'dimension:768'],
            status: 'active',
          },
        ];
      },
    },
    port: {
      async parse() {
        throw new Error('not used by index fixture');
      },
      async embed() {
        return [Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0))];
      },
      async dispatchOutbox() {
        return true;
      },
    },
  });

  const outcome = await processing.handleQueue(
    'knowledge-index',
    String(job!._id),
    `s7-e2e-worker-${suffix}`,
    tenant,
  );
  expect(outcome).toBe('succeeded');
}

const context: TenantContext = {
  workspaceId,
  memberId,
  requestId: `req-s7-e2e-${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:search', 'knowledge:write'],
};

beforeAll(async () => {
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  spaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
  secondSpaceId = await createSpace({
    baseUrl: app.baseUrl,
    authToken,
    workspaceId,
    suffix: `${suffix}b`,
  });
  const source = await request(`/v1/knowledge/spaces/${spaceId}/sources`, {
    method: 'POST',
    idempotencyKey: `s7-source-${suffix}`,
    body: {
      kind: 'text',
      name: `Refund policy ${suffix}`,
      searchEnabled: true,
      metadata: {},
    },
  });
  expect(source.response.status).toBe(201);
  sourceId = String((source.payload.data as { id: string }).id);
  const segment = await request(`/v1/knowledge/sources/${sourceId}/segments`, {
    method: 'POST',
    idempotencyKey: `s7-segment-${suffix}`,
    body: {
      question: 'How long does a refund take?',
      answer: 'Refunds take five business days.',
      searchEnabled: true,
      metadata: { title: 'Refund policy' },
    },
  });
  expect(segment.response.status).toBe(201);
  segmentId = String((segment.payload.data as { id: string }).id);

  const config = loadKnowledgeRuntimeConfig({
    ...process.env,
    KB_MONGO_URI: requiredEnv('KB_TEST_MONGO_URI'),
    KB_REDIS_URL: requiredEnv('KB_TEST_REDIS_URL'),
    KB_PG_URL: requiredEnv('KB_TEST_PG_URL'),
    KB_S3_ENDPOINT: requiredEnv('KB_TEST_S3_ENDPOINT'),
    KB_S3_BUCKET: requiredEnv('KB_TEST_S3_BUCKET'),
    KB_S3_ACCESS_KEY_REF: 'env:KB_S7_E2E_S3_ACCESS',
    KB_S3_SECRET_KEY_REF: 'env:KB_S7_E2E_S3_SECRET',
  });
  connections = await createKnowledgeConnections(config);
  connection = connections.mongo;
  pool = connections.pg;
  await seedS6Index(context);
}, 180_000);

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

describe('S7 real runtime Search page and HTTP contract', () => {
  it('serves S6-indexed fulltext results and a reauthorized citation over HTTP', async () => {
    const client = new S7DownstreamKnowledgeClient({
      baseUrl: app.baseUrl,
      workspaceId,
      credential: authToken,
      requestIdFactory: () => `s7-downstream-${suffix}`,
    });
    const search = await client.searchFulltext({
      knowledgeSpaceId: spaceId,
      query: 'refunds',
      tokenBudget: 5_000,
      similarity: 0.2,
      searchMode: 'fulltext',
      embeddingWeight: 0.5,
      usingRerank: false,
      rerankWeight: 0.5,
    });
    expect(search.status).toBe(200);
    const data = search.data;
    expect(data.partial).toBe(false);
    expect(data.items[0]?.citation.segmentId).toBe(segmentId);

    const citation = await client.getCitation(data.items[0]!.citation.citationId);
    expect(citation.status).toBe(200);
    expect(citation.data).toMatchObject({
      segmentId,
      sourceId,
      title: `Refund policy ${suffix}`,
    });
  });

  it('drives real app HTTP consumers for Chat, Agent, Workflow and citation', async () => {
    const client = new S7DownstreamKnowledgeClient({
      baseUrl: app.baseUrl,
      workspaceId,
      credential: authToken,
      requestIdFactory: () => `s7-real-consumers-${suffix}`,
    });
    const chat = await new ChatHybridConsumer(client).answerInput({
      knowledgeSpaceId: spaceId,
      query: 'refunds',
      tokenBudget: 5_000,
      searchMode: 'hybrid',
      usingRerank: false,
    });
    expect(chat.status).toBe(200);
    expect(chat.data.items.length).toBeGreaterThan(0);

    const agent = await new AgentSemanticConsumer(client).tool({
      knowledgeSpaceId: spaceId,
      query: 'refunds',
      tokenBudget: 5_000,
      searchMode: 'semantic',
      usingRerank: false,
    });
    expect(agent.status).toBe(200);
    expect(agent.data.items[0]?.segment.id).toBe(segmentId);

    const workflow = await new WorkflowMultiConsumer(client).knowledgeNode({
      knowledgeSpaceId: spaceId,
      knowledgeSpaceIds: [spaceId, secondSpaceId],
      query: 'refunds',
      tokenBudget: 5_000,
      searchMode: 'hybrid',
      usingRerank: false,
    });
    expect(workflow.status).toBe(200);
    expect(workflow.data.mode).toBe('multi_space');

    const citation = await new AgentSemanticConsumer(client).citation(
      agent.data.items[0]!.citation.citationId,
    );
    expect(citation.status).toBe(200);
    expect(citation.data.segmentId).toBe(segmentId);
  });

  it('covers real app empty/degraded and 400/401/403/404/429 responses', async () => {
    let requestSequence = 0;
    const client = new S7DownstreamKnowledgeClient({
      baseUrl: app.baseUrl,
      workspaceId,
      credential: authToken,
      requestIdFactory: () => `s7-status-${suffix}-${++requestSequence}`,
    });
    const empty = await client.searchSemantic({
      knowledgeSpaceId: secondSpaceId,
      query: 'refunds',
      tokenBudget: 5_000,
      searchMode: 'semantic',
      usingRerank: false,
    });
    expect(empty.status).toBe(200);
    expect(empty.data.items).toEqual([]);
    expect(empty.data.partial).toBe(false);

    const degraded = await client.searchSemantic({
      knowledgeSpaceId: spaceId,
      query: 'refunds',
      tokenBudget: 5_000,
      searchMode: 'semantic',
      usingRerank: true,
    });
    expect(degraded.status).toBe(200);
    expect(degraded.data.degraded).toContain('rerank_not_configured');

    const endpoint = `${app.baseUrl}/v1/knowledge/search/semantic`;
    const requestBody = JSON.stringify({
      knowledgeSpaceId: spaceId,
      query: '',
      tokenBudget: 5_000,
    });
    const invalid = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...apiHeaders({
          authToken,
          workspaceId,
          idempotencyKey: `s7-invalid-${suffix}`,
        }),
        'content-type': 'application/json',
      },
      body: requestBody,
    });
    expect(invalid.status).toBe(400);

    const unauthorized = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-workspace-id': workspaceId,
        'content-type': 'application/json',
      },
      body: requestBody,
    });
    expect(unauthorized.status).toBe(401);

    const forbidden = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authToken}`,
        'x-workspace-id': `ws_s7_other_${suffix}`,
        'content-type': 'application/json',
      },
      body: requestBody,
    });
    expect(forbidden.status).toBe(403);

    await expect(
      client.searchSemantic({
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f0ffff',
        query: 'refunds',
        tokenBudget: 5_000,
        searchMode: 'semantic',
      }),
    ).rejects.toMatchObject({ status: 404 });

    const limited = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        fetch(endpoint, {
          method: 'POST',
          headers: {
            ...apiHeaders({
              authToken,
              workspaceId,
              idempotencyKey: `s7-rate-${suffix}-${index}`,
            }),
            'content-type': 'application/json',
          },
          body: requestBody,
        }),
      ),
    );
    expect(limited.some((response) => response.status === 429)).toBe(true);
  });

  it('renders Search navigation and page at 360/768/1200 with axe', async () => {
    const cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
    const filters = encodeURIComponent(JSON.stringify({ logic: 'AND', conditions: [] }));
    await verifyResponsivePage({
      baseUrl: app.baseUrl,
      path: `/spaces/${spaceId}/search?mode=fulltext&query=refunds&budget=5000&similarity=0.2&embeddingWeight=0.5&rerankWeight=0.5&rerank=false&spaces=${spaceId}&filters=${filters}`,
      cookie,
      screenshotPrefix: 's7-search',
      resultDir: 's7-search-page',
    });

    const browser = await chromium.launch({ headless: true });
    try {
      const browserContext = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await browserContext.addCookies([cookie]);
      const page = await browserContext.newPage();
      await page.goto(
        `${app.baseUrl}/spaces/${spaceId}/search?mode=fulltext&query=refunds&budget=5000&similarity=0.2&embeddingWeight=0.5&rerankWeight=0.5&rerank=false&spaces=${spaceId}&filters=${filters}`,
        { waitUntil: 'networkidle' },
      );
      await playwrightExpect(page.getByRole('link', { name: '搜索' })).toBeVisible();
      await page.getByRole('button', { name: '运行检索' }).click();
      await playwrightExpect(page.getByText(`Refund policy ${suffix}`)).toBeVisible({
        timeout: 10_000,
      });
      await browserContext.close();
    } finally {
      await browser.close();
    }
  }, 120_000);
});
