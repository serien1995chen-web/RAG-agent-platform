import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../packages/service/src/ports/types';

const context: RequestContext = {
  requestId: 'req-dataset-route',
  tenant: {
    teamId: '000000000000000000000001',
    tmbId: '000000000000000000000002',
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const state = vi.hoisted(() => ({
  created: [] as unknown[],
  updated: [] as unknown[],
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

beforeEach(() => {
  state.created = [];
  state.updated = [];
  state.runtime = {
    datasetApi: {
      listDatasets: async () => ({ total: 1, list: [{ datasetId: 'd1', name: 'demo' }] }),
      createDataset: async (input: unknown) => {
        state.created.push(input);
        return { datasetId: 'd1', state: 'ready' };
      },
      getDatasetDetail: async () => ({
        dataset: {
          datasetId: 'd1',
          teamId: context.tenant.teamId,
          name: 'demo',
          type: 'knowledge',
          parentId: null,
          vectorModel: 'bge-m3',
          indexVersion: 'bge-m3:1536:v1',
          agentModel: null,
          vlmModel: null,
          chunkPolicy: {
            mode: 'auto',
            chunkSize: 1000,
            minSize: 100,
            maxSize: 8000,
            overlapRatio: 0.15,
            paragraphDeep: 5,
            customRegs: [],
            lengthUnit: 'token',
            forceSplit: true,
            maxChunks: 50000,
          },
          inheritPermission: true,
          autoSync: false,
          deleteTime: null,
          version: 1,
          createTime: '2026-01-01T00:00:00.000Z',
          updateTime: '2026-01-01T00:00:00.000Z',
        },
        stats: { collections: 0, datas: 0 },
      }),
      updateDataset: async (input: unknown) => {
        state.updated.push(input);
        return { version: 2 };
      },
    },
    datasetPermission: {
      getPermission: async () => ({
        owner: context.tenant.tmbId,
        permissionMask: 15,
        inherited: true,
        version: 1,
        source: 'local',
      }),
    },
  };
});

describe('Dataset routes (P2-18)', () => {
  it('serves list/create/detail/update without 501999', async () => {
    const list = (await import('../../projects/app/src/pages/api/core/dataset/list')).default;
    const create = (await import('../../projects/app/src/pages/api/core/dataset/create')).default;
    const detail = (await import('../../projects/app/src/pages/api/core/dataset/detail')).default;
    const update = (await import('../../projects/app/src/pages/api/core/dataset/update')).default;

    const listed = responseRecorder();
    await list(
      request({ method: 'GET', url: '/api/core/dataset/list', query: { page: '1', limit: '20' } }),
      listed.response,
    );
    expect(listed.result().status).toBe(200);

    const created = responseRecorder();
    await create(
      request({
        method: 'POST',
        url: '/api/core/dataset/create',
        body: {
          name: 'demo',
          type: 'dataset',
          models: { embeddingModel: 'bge-m3' },
        },
      }),
      created.response,
    );
    expect(created.result().status).toBe(200);

    const detailed = responseRecorder();
    await detail(
      request({
        method: 'GET',
        url: '/api/core/dataset/detail',
        query: { datasetId: '0000000000000000000000aa' },
      }),
      detailed.response,
    );
    expect(detailed.result().status).toBe(200);

    const updated = responseRecorder();
    await update(
      request({
        method: 'POST',
        url: '/api/core/dataset/update',
        body: {
          datasetId: '0000000000000000000000aa',
          version: 1,
          name: 'renamed',
        },
      }),
      updated.response,
    );
    expect(updated.result().status).toBe(200);
    expect(state.updated).toHaveLength(1);
  });
});
