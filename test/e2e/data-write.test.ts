import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../packages/service/src/ports/types';
import type * as SharedApiModule from '../../projects/app/src/shared/api';

const context: RequestContext = {
  requestId: 'req-data-write',
  tenant: {
    teamId: '000000000000000000000001',
    tmbId: '000000000000000000000002',
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const datasetId = '000000000000000000000010';
const collectionId = '000000000000000000000011';
const dataId = '000000000000000000000012';

const state = vi.hoisted(() => ({ runtime: undefined as unknown, enqueued: 0 }));

vi.mock('../../projects/app/src/runtime/health', () => ({
  getRuntime: async () => state.runtime,
}));

vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context, subject: context.tenant }),
}));

function responseRecorder(): {
  response: NextApiResponse;
  result: () => { status: number; body: Record<string, unknown> };
} {
  let status = 200;
  let body: unknown = null;
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
  return { response, result: () => ({ status, body: body as Record<string, unknown> }) };
}

function request(input: {
  method: string;
  url: string;
  query?: Record<string, unknown>;
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

beforeEach(() => {
  state.enqueued = 0;
  const collection = {
    collectionId,
    teamId: context.tenant.teamId,
    datasetId,
    parentId: null,
    type: 'virtual',
    name: 'v',
    tagIds: [],
    sourceRef: 'virtual',
    version: 1,
    createTime: '',
    updateTime: '',
  };
  state.runtime = {
    collectionRepository: { create: async () => ({ collectionId }) },
    collectionService: { getCollection: async () => collection },
    knowledgeItemRepository: {
      updateIndexes: async () => ({ version: 2 }),
      bulkUpsert: async () => ({ upserted: 1, duplicates: 0 }),
    },
    processingRepository: {
      enqueue: async () => {
        state.enqueued += 1;
        return { taskId: `t${state.enqueued}`, jobId: `j${state.enqueued}` };
      },
    },
    config: { datasetRuntime: { maxPushItems: 200 } },
    ports: {
      vectorController: { insert: async () => undefined },
      fullTextStore: { write: async () => undefined },
      trainingProcessor: { process: async () => ({ state: 'success' }) },
      queue: { enqueue: async () => undefined },
    },
  };
});

async function invoke(
  module: { default: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void },
  input: { method: string; url: string; body?: unknown; query?: Record<string, unknown> },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const recorder = responseRecorder();
  await module.default(
    request({ method: input.method, url: input.url, body: input.body, query: input.query }),
    recorder.response,
  );
  return recorder.result();
}

function data(body: Record<string, unknown>): Record<string, unknown> {
  return (body.data ?? {}) as Record<string, unknown>;
}

describe('P4-09 data write routes', () => {
  it('serves the six routes without 501999', async () => {
    const empty =
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/empty');
    const virtual =
      await import('../../projects/app/src/pages/api/core/dataset/collection/virtual');
    const update = await import('../../projects/app/src/pages/api/core/dataset/data/update');
    const insertData =
      await import('../../projects/app/src/pages/api/core/dataset/data/insertData');
    const insertImages =
      await import('../../projects/app/src/pages/api/core/dataset/data/insertImages');
    const pushData = await import('../../projects/app/src/pages/api/core/dataset/data/pushData');

    const emptyResult = await invoke(empty, {
      method: 'POST',
      url: '/api/core/dataset/collection/create/empty',
      body: { datasetId, name: 'empty', type: 'virtual' },
    });
    expect(emptyResult.status).toBe(200);
    expect(data(emptyResult.body)).toMatchObject({ collectionId, type: 'virtual' });

    const virtualResult = await invoke(virtual, {
      method: 'GET',
      url: '/api/core/dataset/collection/virtual',
      query: { collectionId },
    });
    expect(virtualResult.status).toBe(200);
    expect(data(virtualResult.body)).toMatchObject({ virtual: true });

    const updateResult = await invoke(update, {
      method: 'POST',
      url: '/api/core/dataset/data/update',
      body: { dataId, version: 1, q: 'q2' },
    });
    expect(updateResult.status).toBe(200);
    expect(data(updateResult.body)).toMatchObject({ dataId, version: 2 });

    const insertResult = await invoke(insertData, {
      method: 'POST',
      url: '/api/core/dataset/data/insertData',
      body: { collectionId, q: 'question', a: 'answer' },
    });
    expect(insertResult.status).toBe(200);
    expect(typeof data(insertResult.body).dataId).toBe('string');

    const imagesResult = await invoke(insertImages, {
      method: 'POST',
      url: '/api/core/dataset/data/insertImages',
      body: { collectionId, files: [`temp/${context.tenant.teamId}/a.png`], trainingType: 'auto' },
    });
    expect(imagesResult.status).toBe(200);
    expect((data(imagesResult.body).items as Array<Record<string, unknown>>)[0]).toMatchObject({
      mode: 'chunk',
      autoIndexes: true,
    });

    const pushResult = await invoke(pushData, {
      method: 'POST',
      url: '/api/core/dataset/data/pushData',
      body: {
        data: [
          { collectionId, q: 'p1' },
          { collectionId, q: 'p2' },
        ],
      },
    });
    expect(pushResult.status).toBe(200);
    expect(data(pushResult.body).queued).toMatchObject({ accepted: 2 });
  });

  it('rejects pure image insertData with 501038', async () => {
    vi.resetModules();
    vi.doMock('../../projects/app/src/shared/api', async () => {
      const actual = await vi.importActual<SharedApiModule>('../../projects/app/src/shared/api');
      return {
        ...actual,
        parseDto: (name: string, value: unknown) => {
          if (name === 'InsertDataBody') return value;
          return actual.parseDto(name, value);
        },
      };
    });
    const insertData =
      await import('../../projects/app/src/pages/api/core/dataset/data/insertData');
    const result = await invoke(insertData, {
      method: 'POST',
      url: '/api/core/dataset/data/insertData',
      body: { collectionId, q: '', imageId: 'img-1' },
    });
    expect(result.status).toBe(400);
    expect((result.body as { code?: number }).code).toBe(501038);
    vi.doUnmock('../../projects/app/src/shared/api');
    vi.resetModules();
  });

  it('rejects pushData over the item limit before side effects', async () => {
    state.runtime = {
      ...(state.runtime as Record<string, unknown>),
      config: { datasetRuntime: { maxPushItems: 1 } },
    };
    const pushData = await import('../../projects/app/src/pages/api/core/dataset/data/pushData');
    const result = await invoke(pushData, {
      method: 'POST',
      url: '/api/core/dataset/data/pushData',
      body: {
        data: [
          { collectionId, q: 'a' },
          { collectionId, q: 'b' },
        ],
      },
    });
    expect(result.status).toBe(413);
    expect(state.enqueued).toBe(0);
  });

  it('rejects cross-team image keys with 501009', async () => {
    const insertImages =
      await import('../../projects/app/src/pages/api/core/dataset/data/insertImages');
    const result = await invoke(insertImages, {
      method: 'POST',
      url: '/api/core/dataset/data/insertImages',
      body: { collectionId, files: ['temp/other/a.png'] },
    });
    expect((result.body as { code?: number }).code).toBe(501009);
  });
});
