import { randomUUID } from 'node:crypto';
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
import { FileTicketService } from '../../sdk/storage/src/file-ticket';
import { apiHeaders, createSpace, startS4App, type S4AppHarness } from './s4-app-harness';

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
  const now = new Date();
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
    objectKey: `ws/${workspaceId}/space/${spaceId}/refund-flow.png`,
    purpose: 'image',
    sourceId: source._id,
    mimeType: 'image/png',
    sizeBytes: 128,
    etag: 'etag',
    sha256: 'sha256',
    state: 'active',
    expiresAt: null,
    upload: {
      mode: 'single',
      status: 'completed',
      providerUploadId: null,
      pendingObjectKey: null,
      finalObjectKey: `ws/${workspaceId}/space/${spaceId}/refund-flow.png`,
      finalizedAt: now,
      pendingUrlExpiresAt: null,
      partSizeBytes: 128,
      partCount: 1,
      parts: [],
      originalName: 'refund-flow.png',
      completedAt: now,
      abortedAt: null,
    },
  });
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
});
