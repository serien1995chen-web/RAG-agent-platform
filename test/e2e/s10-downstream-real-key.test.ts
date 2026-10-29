import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createKnowledgeConnections,
  KnowledgeFullTextRepository,
  KnowledgeJobExecutionRepository,
  KnowledgeSegmentIndexRepository,
  KnowledgeVectorRepository,
  loadKnowledgeRuntimeConfig,
  registerKnowledgeModels,
  S06ProcessingApplication,
  S5MockModelCatalog,
  S5ProcessingApplication,
  S6ProcessingRepository,
  type KnowledgeConnections,
  type TenantContext,
} from '../../packages/service/src';
import { S7DownstreamKnowledgeClient } from '../../packages/web/src/client/s7-downstream-knowledge-client';
import { createSpace, startS4App, type S4AppHarness } from './s4-app-harness';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s10_down_${suffix}`;
const memberId = `mem_s10_down_${suffix}`;
const authToken = `kb-s10-down-token-${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId,
  requestId: `req-s10-down-${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:search', 'knowledge:write'],
  isWorkspaceOwner: true,
};

let app: S4AppHarness;
let connections: KnowledgeConnections;
let mainSpaceId = '';
let emptySpaceId = '';
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
    token?: string;
    body?: unknown;
    idempotencyKey?: string;
  } = {},
) {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method: input.method ?? 'GET',
    headers: {
      authorization: `Bearer ${input.token ?? authToken}`,
      'x-workspace-id': workspaceId,
      ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  const payload = (await response.json().catch(() => null)) as
    | { success: true; data: unknown }
    | { success: false; error: { code: string } }
    | null;
  return { response, payload };
}

async function createRealKey(
  scopes: string[],
  label: string,
): Promise<{ id: string; version: number; secret: string }> {
  const created = await request('/v1/knowledge/api-keys', {
    method: 'POST',
    idempotencyKey: `s10-down-key-${label}-${suffix}`,
    body: { name: label, scopes, spaceIds: [mainSpaceId, emptySpaceId] },
  });
  expect(created.response.status).toBe(201);
  return created.payload!.success
    ? (created.payload!.data as { id: string; version: number; secret: string })
    : (() => {
        throw new Error('API Key create failed');
      })();
}

async function seedIndex() {
  const models = registerKnowledgeModels(connections.mongo);
  await models.KnowledgeModelBinding.create({
    workspaceId,
    knowledgeSpaceId: new connections.mongo.base.Types.ObjectId(mainSpaceId),
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    modelType: 'embedding',
    modelId: 'mock-embedding-768',
    displayName: 'Mock embedding 768',
    requiredCapabilities: ['text-embedding', 'dimension:768'],
    status: 'active',
    activeQueryModelId: 'mock-embedding-768',
    activeQueryDimension: 768,
    authorizedAt: new Date(),
  });
  await models.KnowledgeModelBinding.create({
    workspaceId,
    knowledgeSpaceId: new connections.mongo.base.Types.ObjectId(emptySpaceId),
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    modelType: 'embedding',
    modelId: 'mock-embedding-768',
    displayName: 'Mock embedding 768',
    requiredCapabilities: ['text-embedding', 'dimension:768'],
    status: 'active',
    activeQueryModelId: 'mock-embedding-768',
    activeQueryDimension: 768,
    authorizedAt: new Date(),
  });
  const jobs = new KnowledgeJobExecutionRepository(connections.mongo);
  const catalog = new S5MockModelCatalog();
  const indexes = new KnowledgeSegmentIndexRepository(connections.mongo, jobs, catalog);
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
    context,
  );
  const job = await models.KnowledgeJob.findOne({
    workspaceId,
    kind: 'index',
    resourceId: segmentId,
  }).lean();
  expect(job).toBeTruthy();
  const processing = new S06ProcessingApplication({
    jobs,
    store: new S6ProcessingRepository(connections.mongo),
    artifacts: {
      async materialize() {
        throw new Error('not used by downstream key fixture');
      },
    },
    processing: new S5ProcessingApplication(),
    vectors: new KnowledgeVectorRepository(connections.pg),
    fulltext: new KnowledgeFullTextRepository(connections.mongo),
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
        throw new Error('not used by downstream key fixture');
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
    await processing.handleQueue(
      'knowledge-index',
      String(job!._id),
      `s10-down-worker-${suffix}`,
      context,
    ),
  ).toBe('succeeded');
}

beforeAll(async () => {
  app = await startS4App({ suffix, workspaceId, memberId, authToken });
  mainSpaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
  emptySpaceId = await createSpace({
    baseUrl: app.baseUrl,
    authToken,
    workspaceId,
    suffix: `${suffix}-empty`,
  });
  const source = await request(`/v1/knowledge/spaces/${mainSpaceId}/sources`, {
    method: 'POST',
    idempotencyKey: `s10-down-source-${suffix}`,
    body: {
      kind: 'text',
      name: `Refund policy ${suffix}`,
      searchEnabled: true,
      metadata: {},
    },
  });
  expect(source.response.status).toBe(201);
  sourceId = String((source.payload!.data as { id: string }).id);
  const segment = await request(`/v1/knowledge/sources/${sourceId}/segments`, {
    method: 'POST',
    idempotencyKey: `s10-down-segment-${suffix}`,
    body: {
      question: 'How long does a refund take?',
      answer: 'Refunds take five business days.',
      searchEnabled: true,
      metadata: { title: 'Refund policy' },
    },
  });
  expect(segment.response.status).toBe(201);
  segmentId = String((segment.payload!.data as { id: string }).id);
  const config = loadKnowledgeRuntimeConfig({
    ...process.env,
    API_KEY_HMAC_SECRET_FILE: `${process.cwd()}/test/fixtures/s10/api-key-hmac.secret`,
    KB_MONGO_URI: requiredEnv('KB_TEST_MONGO_URI'),
    KB_REDIS_URL: requiredEnv('KB_TEST_REDIS_URL'),
    KB_PG_URL: requiredEnv('KB_TEST_PG_URL'),
    KB_S3_ENDPOINT: requiredEnv('KB_TEST_S3_ENDPOINT'),
    KB_S3_BUCKET: requiredEnv('KB_TEST_S3_BUCKET'),
    KB_S3_ACCESS_KEY_REF: 'env:KB_S10_E2E_S3_ACCESS',
    KB_S3_SECRET_KEY_REF: 'env:KB_S10_E2E_S3_SECRET',
  });
  connections = await createKnowledgeConnections(config);
  await seedIndex();
}, 240_000);

afterAll(async () => {
  if (connections) {
    for (const model of Object.values(registerKnowledgeModels(connections.mongo))) {
      await model.deleteMany({ workspaceId });
    }
    for (const table of [
      'knowledge_segment_vectors_768',
      'knowledge_segment_vectors_1024',
      'knowledge_segment_vectors_1536',
      'knowledge_segment_vectors_3072',
    ]) {
      await connections.pg.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
    }
    await connections.close();
  }
  await app?.close();
});

describe('TEST-DOWN-001...004-BLOCK real API Key downstream', () => {
  it('DOWN-001/002/003 run hybrid, semantic, citation and empty semantics over HTTP', async () => {
    const readKey = await createRealKey(['knowledge:read', 'knowledge:search'], 'search');
    let requestSequence = 0;
    const client = new S7DownstreamKnowledgeClient({
      baseUrl: app.baseUrl,
      workspaceId,
      credential: readKey.secret,
      requestIdFactory: () => `s10-down-read-${suffix}-${++requestSequence}`,
    });
    const hybrid = await client.searchHybrid({
      knowledgeSpaceId: mainSpaceId,
      query: 'refunds',
      tokenBudget: 5_000,
      similarity: 0.2,
      searchMode: 'hybrid',
      embeddingWeight: 0.5,
      usingRerank: false,
      rerankWeight: 0.5,
    });
    expect(hybrid.status).toBe(200);
    expect(hybrid.data.items.length).toBeGreaterThan(0);
    expect(hybrid.data.items[0]?.citation.segmentId).toBe(segmentId);

    const semantic = await client.searchSemantic({
      knowledgeSpaceId: mainSpaceId,
      query: 'refunds',
      tokenBudget: 5_000,
      searchMode: 'semantic',
      usingRerank: false,
    });
    expect(semantic.status).toBe(200);
    expect(semantic.data.items[0]?.segment.id).toBe(segmentId);
    const citation = await client.getCitation(semantic.data.items[0]!.citation.citationId);
    expect(citation.status).toBe(200);
    expect(citation.data.segmentId).toBe(segmentId);

    const empty = await client.searchSemantic({
      knowledgeSpaceId: emptySpaceId,
      query: 'refunds',
      tokenBudget: 5_000,
      searchMode: 'semantic',
      usingRerank: false,
    });
    expect(empty.status).toBe(200);
    expect(empty.data.items).toEqual([]);

    const invalidFilter = await request('/v1/knowledge/search/semantic', {
      method: 'POST',
      token: readKey.secret,
      idempotencyKey: `s10-invalid-filter-${suffix}`,
      body: {
        knowledgeSpaceId: mainSpaceId,
        query: 'refunds',
        tokenBudget: 5_000,
        filters: { unknownField: true },
      },
    });
    expect(invalidFilter.response.status).toBe(400);

    const unauthorized = await fetch(`${app.baseUrl}/v1/knowledge/search/hybrid`, {
      method: 'POST',
      headers: {
        'x-workspace-id': workspaceId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        knowledgeSpaceId: mainSpaceId,
        query: 'refunds',
        tokenBudget: 5_000,
        searchMode: 'hybrid',
      }),
    });
    expect(unauthorized.status).toBe(401);
  }, 120_000);

  it('DOWN-004 imports through a real write Key with idempotent replay and no 4xx side effects', async () => {
    const readKey = await createRealKey(['knowledge:read'], 'read-only');
    const writeKey = await createRealKey(['knowledge:read', 'knowledge:write'], 'writer');
    const body = {
      knowledgeSpaceId: mainSpaceId,
      name: `S10 write ${suffix}`,
      directoryId: null,
      text: 'External API Key import body.',
      chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
    };
    const models = registerKnowledgeModels(connections.mongo);
    const before = {
      sources: await models.KnowledgeSource.countDocuments({ workspaceId }),
      jobs: await models.KnowledgeJob.countDocuments({ workspaceId, kind: 'import' }),
    };
    const forbidden = await request(`/v1/knowledge/spaces/${mainSpaceId}/imports/text`, {
      method: 'POST',
      token: readKey.secret,
      idempotencyKey: `s10-write-forbidden-${suffix}`,
      body,
    });
    expect(forbidden.response.status).toBe(403);
    expect({
      sources: await models.KnowledgeSource.countDocuments({ workspaceId }),
      jobs: await models.KnowledgeJob.countDocuments({ workspaceId, kind: 'import' }),
    }).toEqual(before);

    const idempotencyKey = `s10-write-import-${suffix}`;
    const imported = await request(`/v1/knowledge/spaces/${mainSpaceId}/imports/text`, {
      method: 'POST',
      token: writeKey.secret,
      idempotencyKey,
      body,
    });
    expect(imported.response.status).toBe(202);
    const jobId = imported.payload!.success
      ? String((imported.payload!.data as { jobId: string }).jobId)
      : '';
    expect(jobId).toMatch(/^[a-f0-9]{24}$/);
    const replay = await request(`/v1/knowledge/spaces/${mainSpaceId}/imports/text`, {
      method: 'POST',
      token: writeKey.secret,
      idempotencyKey,
      body,
    });
    expect(replay.response.status).toBe(202);
    expect((replay.payload!.data as { jobId: string }).jobId).toBe(jobId);
    expect(await models.KnowledgeJob.countDocuments({ workspaceId, kind: 'import' })).toBe(
      before.jobs + 1,
    );
    expect(await models.KnowledgeSource.countDocuments({ workspaceId })).toBe(before.sources + 1);
  });
});
