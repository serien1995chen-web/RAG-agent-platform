import { ApiErrorException, createApiError } from '../../packages/contracts/src/index';
import { MemoryIdempotencyStore } from '../../packages/dal/src/index';
import { EmbeddingService } from '../../packages/service/src/modules/index/application/embedding.service';
import type {
  CollectionSnapshot,
  KnowledgeBaseSnapshot,
  KnowledgeItemSnapshot,
  RequestContext,
  VectorRecord,
} from '../../packages/service/src/ports/types';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import retrainRoute from '../../projects/app/src/pages/api/core/dataset/collection/retrain';
import rebuildRoute from '../../projects/app/src/pages/api/core/dataset/rebuildEmbedding';

const context: RequestContext = {
  requestId: 'req-rebuild-retrain',
  tenant: {
    teamId: '000000000000000000000001',
    tmbId: '000000000000000000000002',
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const datasetId = '000000000000000000000101';
const collectionId = '000000000000000000000102';
const dataId = '000000000000000000000103';

const state = vi.hoisted(() => ({
  runtime: undefined as unknown,
}));

vi.mock('../../projects/app/src/runtime', () => ({
  getRuntime: async () => state.runtime,
}));
vi.mock('../../projects/app/src/runtime/health', () => ({
  getRuntime: async () => state.runtime,
}));
vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context, subject: context.tenant }),
}));

function responseRecorder(): {
  response: NextApiResponse;
  result: () => { status: number; body: unknown };
} {
  let status = 200;
  let body: unknown;
  const response = {
    setHeader: () => response,
    status(code: number) {
      status = code;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    },
  } as unknown as NextApiResponse;
  return { response, result: () => ({ status, body }) };
}

function request(input: {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}): NextApiRequest {
  return {
    method: input.method,
    url: input.url,
    query: {},
    body: input.body,
    headers: input.headers ?? {},
  } as unknown as NextApiRequest;
}

function dataset(): KnowledgeBaseSnapshot & { indexVersion: string } {
  return {
    datasetId,
    teamId: context.tenant.teamId,
    parentId: null,
    type: 'knowledge',
    name: 'dataset',
    vectorModel: 'old-model',
    indexVersion: 'old-model:1536:v1',
    inheritPermission: true,
    autoSync: false,
    deleteTime: null,
    version: 1,
    createTime: '2026-10-14T00:00:00.000Z',
    updateTime: '2026-10-14T00:00:00.000Z',
  };
}

function collection(): CollectionSnapshot {
  return {
    collectionId,
    teamId: context.tenant.teamId,
    datasetId,
    parentId: null,
    type: 'file',
    name: 'source',
    tagIds: [],
    sourceRef: '{"fileId":"source-file"}',
    trainingPolicy: { mode: 'auto' },
    version: 1,
    createTime: '2026-10-14T00:00:00.000Z',
    updateTime: '2026-10-14T00:00:00.000Z',
  };
}

function item(rebuilding = false): KnowledgeItemSnapshot {
  return {
    dataId,
    teamId: context.tenant.teamId,
    datasetId,
    collectionId,
    q: 'alpha',
    a: 'answer',
    indexes: [
      {
        indexId: `${dataId}:default`,
        type: 'default',
        dataId: 'old-vector-id',
        text: 'alpha',
      },
    ],
    rebuilding,
    version: 1,
    createTime: '2026-10-14T00:00:00.000Z',
    updateTime: '2026-10-14T00:00:00.000Z',
  };
}

function buildRuntime(
  options: { rebuilding?: boolean; queued?: boolean; permissionMask?: number } = {},
) {
  const events: string[] = [];
  const vectors = new Map<string, VectorRecord[]>();
  let currentDataset = dataset();
  let currentItem = item(options.rebuilding ?? false);
  const sourceCollection = collection();
  const taskFacts: Array<{ budgetKind?: string }> = [];
  const trainingCalls: Array<{ mode: string }> = [];
  const deletions = {
    data: 0,
    vectors: 0,
    fullText: 0,
    training: 0,
  };

  const knowledgeBase = {
    async findByDatasetId() {
      return currentDataset;
    },
    async get() {
      return currentDataset;
    },
    async create() {
      throw new Error('not used');
    },
    async update(input: { version: number; patch: { vectorModel?: string } }) {
      if (input.version !== currentDataset.version) {
        throw new ApiErrorException(
          createApiError({ code: 501067, requestId: context.requestId, params: {} }),
        );
      }
      currentDataset = {
        ...currentDataset,
        vectorModel: input.patch.vectorModel ?? currentDataset.vectorModel,
        version: currentDataset.version + 1,
      };
      events.push('mongo:update-model');
      return { version: currentDataset.version };
    },
    async switchIndexVersion(input: {
      expectedVersion: number;
      expectedIndexVersion: string;
      nextIndexVersion: string;
    }) {
      if (
        input.expectedVersion !== currentDataset.version ||
        input.expectedIndexVersion !== currentDataset.indexVersion
      ) {
        throw new ApiErrorException(
          createApiError({ code: 501067, requestId: context.requestId, params: {} }),
        );
      }
      currentDataset = {
        ...currentDataset,
        indexVersion: input.nextIndexVersion,
        version: currentDataset.version + 1,
      };
      events.push('cas:switch-index-version');
      return { version: currentDataset.version };
    },
    async softDelete() {
      return { deleteJobId: 'delete' };
    },
  };
  const collectionRepository = {
    async get() {
      return sourceCollection;
    },
    async list() {
      return { total: 1, list: [sourceCollection], cursor: null };
    },
    async create() {
      return { collectionId };
    },
    async update(input: { version: number; patch: { trainingPolicy?: unknown } }) {
      if (input.version !== sourceCollection.version) {
        throw new ApiErrorException(
          createApiError({ code: 501067, requestId: context.requestId, params: {} }),
        );
      }
      sourceCollection.trainingPolicy = input.patch.trainingPolicy;
      sourceCollection.version += 1;
      events.push('mongo:update-policy');
      return { version: sourceCollection.version };
    },
    async deleteTree() {
      return { deleteJobId: 'delete' };
    },
  };
  const itemRepository = {
    async list() {
      return { total: 1, list: [currentItem], cursor: null };
    },
    async get() {
      return currentItem;
    },
    async bulkUpsert(input: { items: KnowledgeItemSnapshot[] }) {
      currentItem = { ...currentItem, ...input.items[0] };
      events.push(`mongo:rebuilding:${String(currentItem.rebuilding)}`);
      return { upserted: 0, duplicates: input.items.length };
    },
    async updateIndexes(input: { version: number; indexes: KnowledgeItemSnapshot['indexes'] }) {
      if (input.version !== currentItem.version) {
        throw new ApiErrorException(
          createApiError({ code: 501067, requestId: context.requestId, params: {} }),
        );
      }
      currentItem = {
        ...currentItem,
        indexes: input.indexes,
        version: currentItem.version + 1,
      };
      events.push('mongo:update-indexes');
      return { version: currentItem.version };
    },
    async deleteByScope(input: { collectionId?: string }) {
      deletions.data += 1;
      events.push(`delete:data:${input.collectionId ?? ''}`);
      return { deleted: 1 };
    },
  };
  const vectorController = {
    async insert(input: { records: VectorRecord[] }) {
      for (const record of input.records) {
        const list = vectors.get(record.indexVersion) ?? [];
        list.push(record);
        vectors.set(record.indexVersion, list);
      }
      events.push('vector:insert');
      return { inserted: input.records.length };
    },
    async delete(input: { dataIds?: string[]; collectionId?: string }) {
      deletions.vectors += 1;
      if (input.dataIds) {
        for (const [version, records] of vectors) {
          vectors.set(
            version,
            records.filter((record) => !input.dataIds?.includes(record.dataId)),
          );
        }
      }
      events.push(input.dataIds ? 'vector:delete-stale' : 'vector:delete-collection');
      return { deleted: input.dataIds?.length ?? 1 };
    },
    async embRecall() {
      return [];
    },
    async getVectorDataByTime() {
      return [];
    },
    async getVectorCount() {
      return 0;
    },
  };
  const fullText = {
    async search() {
      return [];
    },
    async write() {
      events.push('fulltext:write');
    },
    async deleteByDataId() {
      return { deleted: 1 };
    },
    async deleteByDatasetIds() {
      return { deleted: 1 };
    },
    async deleteByCollectionIds() {
      deletions.fullText += 1;
      events.push('delete:fulltext');
      return { deleted: 1 };
    },
  };
  const processingService = {
    async getQueueStats() {
      return options.queued ? [{ mode: 'parse', depth: 1, running: 0 }] : [];
    },
    async enqueueJob(input: { budgetKind?: string }) {
      taskFacts.push(input);
      events.push('mongo:enqueue-rebuild');
      return { taskId: 'task-rebuild', jobId: 'job-rebuild' };
    },
    async deleteTrainingData() {
      deletions.training += 1;
      events.push('delete:training');
      return { deletedCount: 1 };
    },
  };
  const embedding = new EmbeddingService({
    gateway: {
      async embed(input) {
        return input.texts.map(() => Array.from({ length: 1536 }, () => 0.1));
      },
    },
  });
  const runtime = {
    clients: { idempotencyStore: new MemoryIdempotencyStore() },
    datasetPermission: {
      async getPermission() {
        return {
          owner: context.tenant.tmbId,
          permissionMask: options.permissionMask ?? 8,
          inherited: true,
          version: 1,
          source: 'local',
        };
      },
    },
    knowledgeBaseRepository: knowledgeBase,
    collectionRepository,
    knowledgeItemRepository: itemRepository,
    processingService,
    embeddingService: embedding,
    vectorController,
    fullTextStore: fullText,
    ports: {
      fullTextStore: fullText,
      trainingProcessor: {
        async process(task: { mode: string }) {
          trainingCalls.push(task);
          events.push('training:process');
          return { state: 'success' };
        },
      },
      tenantQuotaProvider: {
        async check() {
          return { allowed: true, limit: 10, current: 0 };
        },
      },
    },
  };
  return {
    runtime,
    events,
    vectors,
    deletions,
    taskFacts,
    trainingCalls,
    getDataset: () => currentDataset,
  };
}

beforeEach(() => {
  state.runtime = buildRuntime().runtime;
});

describe('P6-02 rebuild and retrain routes', () => {
  it('ACC-REBUILD-001/002 writes new vectors, switches CAS, cleans old vectors and keeps budget 50', async () => {
    const built = buildRuntime();
    state.runtime = built.runtime;
    const recorder = responseRecorder();
    await rebuildRoute(
      request({
        method: 'POST',
        url: '/api/core/dataset/rebuildEmbedding',
        body: {
          datasetId,
          modelRef: { provider: 'openai', model: 'new-model', dimension: 1536 },
        },
      }),
      recorder.response,
    );

    expect(recorder.result().status).toBe(200);
    expect(built.taskFacts[0]?.budgetKind).toBe('rebuild');
    expect(built.events.at(-1)).toBe('cas:switch-index-version');
    expect(built.events).toContain('vector:delete-stale');
    expect(built.getDataset().indexVersion).toBe('new-model:1536:v1');
    expect(built.vectors.has('new-model:1536:v1')).toBe(true);
  });

  it('TEST-TASK-RETRY-001 rejects same model and conflicting processing with fixed errors', async () => {
    const sameModel = responseRecorder();
    await rebuildRoute(
      request({
        method: 'POST',
        url: '/api/core/dataset/rebuildEmbedding',
        body: {
          datasetId,
          modelRef: { provider: 'openai', model: 'old-model', dimension: 1536 },
        },
      }),
      sameModel.response,
    );
    expect(sameModel.result().status).toBe(500);
    expect((sameModel.result().body as { code: number }).code).toBe(501013);

    const queued = buildRuntime({ queued: true });
    state.runtime = queued.runtime;
    const conflict = responseRecorder();
    await rebuildRoute(
      request({
        method: 'POST',
        url: '/api/core/dataset/rebuildEmbedding',
        body: {
          datasetId,
          modelRef: { provider: 'openai', model: 'new-model', dimension: 1536 },
        },
      }),
      conflict.response,
    );
    expect(conflict.result().status).toBe(409);
    expect((conflict.result().body as { code: number }).code).toBe(501069);
  });

  it('ACC-DATA-004 rejects a non-1536 rebuild dimension with 501013', async () => {
    const recorder = responseRecorder();
    await rebuildRoute(
      request({
        method: 'POST',
        url: '/api/core/dataset/rebuildEmbedding',
        body: {
          datasetId,
          modelRef: { provider: 'openai', model: 'new-model', dimension: 1024 },
        },
      }),
      recorder.response,
    );
    expect(recorder.result().status).toBe(500);
    expect((recorder.result().body as { code: number }).code).toBe(501013);
  });

  it('ACC-REBUILD-002 retrains with source preserved while old derived stores are cleared', async () => {
    const built = buildRuntime();
    state.runtime = built.runtime;
    const recorder = responseRecorder();
    await retrainRoute(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/retrain',
        headers: { 'idempotency-key': 'retrain-1' },
        body: {
          collectionId,
          policy: {
            mode: 'paragraph',
            chunkSize: 500,
            minSize: 50,
            maxSize: 1000,
            overlapRatio: 0,
            paragraphDeep: 2,
            customRegs: [],
            lengthUnit: 'char',
            forceSplit: true,
            maxChunks: 100,
          },
        },
      }),
      recorder.response,
    );
    expect(recorder.result().status).toBe(200);
    expect(built.deletions).toEqual({ data: 1, vectors: 1, fullText: 1, training: 1 });
    expect(built.trainingCalls).toHaveLength(1);
    expect(built.trainingCalls[0]?.mode).toBe('parse');
    const updatedCollection = await built.runtime.collectionRepository.get(
      { collectionId, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(updatedCollection.sourceRef).toBe('{"fileId":"source-file"}');
    expect((updatedCollection.trainingPolicy as { mode: string }).mode).toBe('paragraph');
  });
});
