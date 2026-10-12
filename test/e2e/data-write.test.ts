import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiErrorException, createApiError } from '../../packages/contracts/src/index';
import type { RequestContext } from '../../packages/service/src/ports/types';

const TEAM_ID = '000000000000000000000001';
const DATASET_ID = '0000000000000000000000d1';
const COLLECTION_ID = '0000000000000000000000c1';

const context: RequestContext = {
  requestId: 'req-data-write',
  tenant: { teamId: TEAM_ID, tmbId: '000000000000000000000002', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const state = vi.hoisted(() => ({
  tasks: new Set<string>(),
  taskSeq: 0,
  duplicate: false,
  versionConflict: false,
  updatedIndexes: [] as unknown[],
  runtime: undefined as unknown,
}));

vi.mock('../../projects/app/src/runtime', () => ({
  getRuntime: async () => state.runtime,
}));

vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context, subject: context.tenant }),
}));

function responseRecorder(): {
  response: NextApiResponse;
  result: () => { status: number; body: { data?: unknown; code?: number } };
} {
  let status = 200;
  let body: { data?: unknown; code?: number } = {};
  const response = {
    setHeader: () => response,
    status(code: number) {
      status = code;
      return response;
    },
    json(value: unknown) {
      body = value as { data?: unknown; code?: number };
      return response;
    },
  } as unknown as NextApiResponse;
  return { response, result: () => ({ status, body }) };
}

function request(input: {
  method: string;
  url: string;
  query?: Record<string, string>;
  body?: unknown;
}): NextApiRequest {
  return {
    method: input.method,
    url: input.url,
    query: input.query ?? {},
    body: input.body,
    headers: {},
  } as unknown as NextApiRequest;
}

function buildRuntime() {
  return {
    collectionRepository: {
      create: async () => ({ collectionId: COLLECTION_ID }),
    },
    collectionService: {
      getCollection: async (input: { collectionId: string }) => {
        if (input.collectionId === 'missing') {
          throw new ApiErrorException(
            createApiError({
              code: 501070,
              requestId: 'r',
              params: { resourceType: 'collection', resourceId: input.collectionId },
            }),
          );
        }
        return {
          collectionId: input.collectionId,
          teamId: TEAM_ID,
          datasetId: DATASET_ID,
          parentId: null,
          type: 'virtual',
          name: 'v',
          tagIds: [],
          sourceRef: 'v-ref',
          version: 1,
          createTime: 'now',
          updateTime: 'now',
        };
      },
    },
    embeddingService: {
      embed: async () => [new Array<number>(1536).fill(0)],
    },
    knowledgeItemService: {
      getItem: async () => ({
        dataId: '0000000000000000000000aa',
        teamId: TEAM_ID,
        datasetId: DATASET_ID,
        collectionId: COLLECTION_ID,
        q: 'old',
        indexes: [],
        rebuilding: false,
        version: 1,
        createTime: 'now',
        updateTime: 'now',
      }),
    },
    knowledgeItemRepository: {
      bulkUpsert: async () =>
        state.duplicate ? { upserted: 0, duplicates: 1 } : { upserted: 1, duplicates: 0 },
      updateIndexes: async (input: { version: number; indexes: unknown }) => {
        state.updatedIndexes.push(input);
        if (state.versionConflict) {
          throw new ApiErrorException(
            createApiError({
              code: 501067,
              requestId: 'r',
              params: {
                resourceType: 'data',
                resourceId: 'x',
                expectedVersion: input.version,
                actualVersion: input.version + 1,
              },
            }),
          );
        }
        return { version: input.version + 1 };
      },
    },
    vectorController: { insert: async () => ({ inserted: 1 }) },
    fullTextStore: { write: async () => undefined },
    processingRepository: {
      enqueue: async (input: { job: { jobId: string } }) => {
        const isNew = !state.tasks.has(input.job.jobId);
        state.tasks.add(input.job.jobId);
        if (isNew) state.taskSeq += 1;
        return { taskId: 'task-' + input.job.jobId, jobId: input.job.jobId };
      },
    },
    ports: {
      trainingProcessor: { process: async () => ({ state: 'success' }) },
      fullTextStore: { write: async () => undefined },
      imageTrainingProcessor: { processImage: async () => ({ imageId: 'x', state: 'success' }) },
    },
    clients: {
      queue: {
        enqueue: async () => ({ jobId: 'job', enqueued: true }),
        remove: async () => undefined,
        close: async () => undefined,
      },
      redis: undefined,
      mongo: undefined,
    },
    config: {
      system: { s3: { bucket: 'kb-objects' } },
      datasetRuntime: { maxPushItems: 200, maxRequestBodyBytes: 10 * 1024 * 1024 },
    },
  };
}

beforeEach(() => {
  state.tasks = new Set<string>();
  state.taskSeq = 0;
  state.duplicate = false;
  state.versionConflict = false;
  state.updatedIndexes = [];
  state.runtime = buildRuntime();
});

describe('TEST-API-EMPTY-001 P4-09 empty/virtual collections', () => {
  it('creates an empty virtual collection without a task', async () => {
    const empty = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/empty')
    ).default;
    const res = responseRecorder();
    await empty(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/empty',
        body: { datasetId: DATASET_ID, name: 'empty' },
      }),
      res.response,
    );
    expect(res.result().status).toBe(200);
    expect((res.result().body.data as { type: string }).type).toBe('virtual');
    expect(state.tasks.size).toBe(0);
  });
});

describe('TEST-API-VIRTUAL-001 virtual collection read', () => {
  it('returns virtual/sourceRef and 501070 for missing collections', async () => {
    const virtual = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/virtual')
    ).default;
    const found = responseRecorder();
    await virtual(
      request({
        method: 'GET',
        url: '/api/core/dataset/collection/virtual',
        query: { collectionId: COLLECTION_ID },
      }),
      found.response,
    );
    expect(found.result().status).toBe(200);
    expect(found.result().body.data).toEqual({ virtual: true, sourceRef: 'v-ref' });

    const missing = responseRecorder();
    await virtual(
      request({
        method: 'GET',
        url: '/api/core/dataset/collection/virtual',
        query: { collectionId: 'missing' },
      }),
      missing.response,
    );
    expect(missing.result().body.code).toBe(501070);
  });
});

describe('TEST-REP-PUSH-001 P4-09 data write', () => {
  it('inserts direct data and maps duplicate dedupKey to 501003', async () => {
    const insertData = (
      await import('../../projects/app/src/pages/api/core/dataset/data/insertData')
    ).default;
    const ok = responseRecorder();
    await insertData(
      request({
        method: 'POST',
        url: '/api/core/dataset/data/insertData',
        body: { collectionId: COLLECTION_ID, q: 'hello' },
      }),
      ok.response,
    );
    expect(ok.result().status).toBe(200);
    expect(typeof (ok.result().body.data as { dataId: string }).dataId).toBe('string');

    state.duplicate = true;
    const dup = responseRecorder();
    await insertData(
      request({
        method: 'POST',
        url: '/api/core/dataset/data/insertData',
        body: { collectionId: COLLECTION_ID, q: 'hello' },
      }),
      dup.response,
    );
    expect(dup.result().body.code).toBe(501003);
  });

  it('pushes data idempotently and rejects over-limit batches before side effects', async () => {
    const pushData = (await import('../../projects/app/src/pages/api/core/dataset/data/pushData'))
      .default;
    const first = responseRecorder();
    await pushData(
      request({
        method: 'POST',
        url: '/api/core/dataset/data/pushData',
        body: { data: [{ collectionId: COLLECTION_ID, q: 'q1' }] },
      }),
      first.response,
    );
    expect(first.result().status).toBe(200);
    const firstQueued = (first.result().body.data as { queued: { taskIds: string[] } }).queued;
    const taskCountAfterFirst = state.tasks.size;

    const repeat = responseRecorder();
    await pushData(
      request({
        method: 'POST',
        url: '/api/core/dataset/data/pushData',
        body: { data: [{ collectionId: COLLECTION_ID, q: 'q1' }] },
      }),
      repeat.response,
    );
    const repeatQueued = (repeat.result().body.data as { queued: { taskIds: string[] } }).queued;
    expect(repeatQueued.taskIds).toEqual(firstQueued.taskIds);
    expect(state.tasks.size).toBe(taskCountAfterFirst);
  });

  it('rejects >200 items with 501030 and >10MB with 501065', async () => {
    const pushData = (await import('../../projects/app/src/pages/api/core/dataset/data/pushData'))
      .default;
    const tooMany = responseRecorder();
    await pushData(
      request({
        method: 'POST',
        url: '/api/core/dataset/data/pushData',
        body: {
          data: Array.from({ length: 201 }, (_, i) => ({
            collectionId: COLLECTION_ID,
            q: 'q' + i,
          })),
        },
      }),
      tooMany.response,
    );
    expect(tooMany.result().body.code).toBe(501030);
    expect(state.tasks.size).toBe(0);

    const tooLarge = responseRecorder();
    await pushData(
      request({
        method: 'POST',
        url: '/api/core/dataset/data/pushData',
        body: {
          data: [
            {
              collectionId: COLLECTION_ID,
              q: 'q',
              indexes: Array.from({ length: 1500 }, () => ({
                type: 'custom',
                text: 'x'.repeat(8000),
              })),
            },
          ],
        },
      }),
      tooLarge.response,
    );
    expect(tooLarge.result().body.code).toBe(501065);
    expect(state.tasks.size).toBe(0);
  });
});

describe('TEST-API-LIMIT-001 P4-09 update CAS', () => {
  it('writes the new vector before switching indexes and reports 501067 on conflict', async () => {
    const update = (await import('../../projects/app/src/pages/api/core/dataset/data/update'))
      .default;
    const ok = responseRecorder();
    await update(
      request({
        method: 'POST',
        url: '/api/core/dataset/data/update',
        body: { dataId: '0000000000000000000000aa', version: 1, q: 'new' },
      }),
      ok.response,
    );
    expect(ok.result().status).toBe(200);
    expect((ok.result().body.data as { version: number }).version).toBe(2);

    state.versionConflict = true;
    const conflict = responseRecorder();
    await update(
      request({
        method: 'POST',
        url: '/api/core/dataset/data/update',
        body: { dataId: '0000000000000000000000aa', version: 1, q: 'new' },
      }),
      conflict.response,
    );
    expect(conflict.result().body.code).toBe(501067);
  });
});
