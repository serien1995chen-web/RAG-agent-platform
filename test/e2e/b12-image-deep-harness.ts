import { randomUUID } from 'node:crypto';
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
import { apiHeaders, createSpace, startS4App, type S4AppHarness } from './s4-app-harness';

export interface B12ImageDeepRequest {
  method?: 'GET' | 'POST';
  body?: unknown;
  idempotencyKey?: string;
}

export interface B12ImageDeepHarness {
  suffix: string;
  workspaceId: string;
  memberId: string;
  authToken: string;
  app: S4AppHarness;
  connections: KnowledgeConnections;
  connection: KnowledgeConnections['mongo'];
  pool: KnowledgeConnections['pg'];
  spaceId: string;
  textSourceId: string;
  textSegmentId: string;
  imageSourceId: string;
  imageBlobRefId: string;
  request(
    path: string,
    input?: B12ImageDeepRequest,
  ): Promise<{
    response: Response;
    payload: {
      success: boolean;
      data: Record<string, unknown>;
    };
  }>;
  close(): Promise<void>;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required e2e environment: ${name}`);
  return value;
}

function createObjectStore() {
  const endpoint = new URL(requiredEnv('KB_TEST_S3_ENDPOINT'));
  return new MinioKnowledgeObjectStore({
    provider: 'minio',
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey: requiredEnv('KB_TEST_S3_ACCESS_KEY'),
    secretKey: requiredEnv('KB_TEST_S3_SECRET_KEY'),
    region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
    bucket: requiredEnv('KB_TEST_S3_BUCKET'),
  });
}

export async function startB12ImageDeepHarness(
  input: {
    suffix?: string;
    pricingProfile?: 'zero-v1' | 'fixture-v1';
    quotaProfile?: 'free-v1' | 's11-perf-v1';
  } = {},
): Promise<B12ImageDeepHarness> {
  const suffix = input.suffix ?? randomUUID().replaceAll('-', '').slice(0, 12);
  const workspaceId = `ws_s8_e2e_${suffix}`;
  const memberId = `mem_s8_e2e_${suffix}`;
  const authToken = `kb-s8-e2e-token-${suffix}`;
  const app = await startS4App({
    suffix,
    workspaceId,
    memberId,
    authToken,
    ...(input.pricingProfile ? { pricingProfile: input.pricingProfile } : {}),
    ...(input.quotaProfile ? { quotaProfile: input.quotaProfile } : {}),
  });
  let connections: KnowledgeConnections | undefined;
  let pool: KnowledgeConnections['pg'] | undefined;
  let spaceId = '';
  let textSourceId = '';
  let textSegmentId = '';
  let imageSourceId = '';
  let imageBlobRefId = '';

  const request = async (path: string, requestInput: B12ImageDeepRequest = {}) => {
    const response = await fetch(`${app.baseUrl}${path}`, {
      method: requestInput.method ?? 'GET',
      headers: {
        ...apiHeaders({
          authToken,
          workspaceId,
          ...(requestInput.idempotencyKey ? { idempotencyKey: requestInput.idempotencyKey } : {}),
        }),
        ...(requestInput.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(requestInput.body !== undefined ? { body: JSON.stringify(requestInput.body) } : {}),
    });
    return {
      response,
      payload: (await response.json()) as {
        success: boolean;
        data: Record<string, unknown>;
      },
    };
  };

  const close = async () => {
    const connection = connections?.mongo;
    const cleanupContext: TenantContext = {
      workspaceId,
      memberId,
      knowledgeSpaceId: spaceId,
      requestId: `cleanup-s8-${suffix}`,
      traceId: suffix.padEnd(32, '0').slice(0, 32),
      scopes: ['knowledge:read', 'knowledge:write'],
      isWorkspaceOwner: true,
    };
    try {
      if (process.env.KB_TEST_S3_ENDPOINT && connection) {
        const objectStore = createObjectStore();
        const refs = await connection.models.KnowledgeObjectRef.find({ workspaceId }).lean();
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
    } finally {
      await connections?.close();
      await app.close();
    }
  };

  try {
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
    const connection = connections.mongo;
    pool = connections.pg;
    const context: TenantContext = {
      workspaceId,
      memberId,
      requestId: `seed-s8-${suffix}`,
      traceId: suffix.padEnd(32, '0').slice(0, 32),
      scopes: ['knowledge:read', 'knowledge:write', 'knowledge:search'],
      isWorkspaceOwner: true,
    };

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
    if (
      (await processor.handleQueue(
        'knowledge-index',
        String(job?._id),
        `s8-index-worker-${suffix}`,
        context,
      )) !== 'succeeded'
    ) {
      throw new Error('B12 image deep text index job did not succeed');
    }

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
    const objectStore = createObjectStore();
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
    const caption = new S8CaptionApplication({
      store: new S6ProcessingRepository(connection),
      objects: new KnowledgeObjectRefRepository(connection),
      models: new S8ModelResolver(connection, catalog),
      gateway: {
        async invoke<T>(modelRequest) {
          if (modelRequest.kind === 'vlm') {
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
              actualModelId: modelRequest.modelId,
              attempts: 1,
              fallbackUsed: false,
              degraded: false,
              usage: { inputTokens: 2, outputTokens: 1, quantity: 3 },
            };
          }
          return {
            data: {
              data: Array.from({ length: modelRequest.input?.length ?? 0 }, (_, index) => ({
                index,
                embedding: Array.from({ length: 768 }, (_, vectorIndex) =>
                  vectorIndex === index ? 1 : 0,
                ),
              })),
            } as T,
            actualModelId: modelRequest.modelId,
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
      indexes: new S8ImageIndexRepository(connection),
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

    return {
      suffix,
      workspaceId,
      memberId,
      authToken,
      app,
      connections,
      connection,
      pool: connections.pg,
      spaceId,
      textSourceId,
      textSegmentId,
      imageSourceId,
      imageBlobRefId,
      request,
      close,
    };
  } catch (error) {
    const appOutput = app.output();
    await close();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${appOutput}`, {
      cause: error,
    });
  }
}
