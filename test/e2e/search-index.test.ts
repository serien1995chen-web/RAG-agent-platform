import { ApiErrorException, createApiError } from '../../packages/contracts/src/index';
import type { SearchRequest } from '../../packages/contracts/src/index';
import { IndexApplicationService } from '../../packages/service/src/index';
import type { RequestContext, VectorController } from '../../packages/service/src/index';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import searchTestRoute from '../../projects/app/src/pages/api/core/dataset/searchTest';
import internalSearchRoute from '../../projects/app/src/pages/api/internal/dataset/search';
import indexCreateRoute from '../../projects/app/src/pages/api/core/dataset/index/create';
import indexUpdateRoute from '../../projects/app/src/pages/api/core/dataset/index/update';
import indexDeleteRoute from '../../projects/app/src/pages/api/core/dataset/index/delete';

const context: RequestContext = {
  requestId: 'req-search-index',
  tenant: {
    teamId: 'team-a',
    tmbId: '000000000000000000000002',
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const state = vi.hoisted(() => ({
  runtime: undefined as unknown,
  searchCalls: [] as unknown[],
}));

vi.mock('../../projects/app/src/runtime', () => ({ getRuntime: async () => state.runtime }));
vi.mock('../../projects/app/src/runtime/health', () => ({ getRuntime: async () => state.runtime }));
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

function emptyResult(): { citations: never[]; stats: Record<string, unknown> } {
  return {
    citations: [],
    stats: {
      searchMode: 'embedding',
      usingReRank: false,
      usingSimilarityFilter: false,
      embeddingTokens: 0,
      rerankInputTokens: 0,
      degraded: [],
      durationMs: 1,
    },
  };
}

function buildRuntime(
  overrides: {
    subjectTeamId?: string;
    providerConcurrency?: number;
    search?: (body: SearchRequest, ctx: RequestContext) => Promise<unknown>;
  } = {},
) {
  const item = {
    dataId: '0000000000000000000000aa',
    teamId: context.tenant.teamId,
    datasetId: 'd1',
    collectionId: 'c1',
    indexes: [
      { indexId: '0000000000000000000000aa:default', type: 'default', dataId: 'v0', text: 'sys' },
      {
        indexId: '0000000000000000000000aa:custom',
        type: 'custom',
        dataId: 'v1',
        text: 'custom',
      },
    ],
    rebuilding: false,
    version: 1,
    createTime: '2026-01-01T00:00:00.000Z',
    updateTime: '2026-01-01T00:00:00.000Z',
  };
  const itemState = { item };
  const items = {
    get: async () => itemState.item,
    updateIndexes: async (input: { dataId: string; version: number; indexes: unknown[] }) => {
      if (input.version !== itemState.item.version) {
        throw new ApiErrorException(
          createApiError({
            code: 501067,
            requestId: context.requestId,
            params: {
              resourceType: 'data',
              resourceId: input.dataId,
              expectedVersion: input.version,
              actualVersion: itemState.item.version,
            },
          }),
        );
      }
      itemState.item = {
        ...itemState.item,
        indexes: input.indexes as typeof itemState.item.indexes,
        version: itemState.item.version + 1,
      };
      return { version: itemState.item.version };
    },
  };
  const indexService = new IndexApplicationService({
    repository: {} as unknown as VectorController,
    items,
  });
  const search = overrides.search ?? (async () => emptyResult());
  return {
    config: { capacity: { providerConcurrency: overrides.providerConcurrency ?? 4 } },
    extensions: {
      get: (id: string) => (id === 'identity' ? { resolve: async () => context.tenant } : null),
    },
    datasetApi: {
      getDatasetDetail: async () => ({
        dataset: { datasetId: 'd1', vectorModel: 'bge-m3' },
        stats: { collections: 0, datas: 0 },
      }),
    },
    datasetSearch: {
      search: async (body: SearchRequest, ctx: RequestContext) => {
        state.searchCalls.push(body);
        return search(body, ctx);
      },
    },
    indexService,
  };
}

beforeEach(() => {
  state.searchCalls = [];
  state.runtime = buildRuntime();
});

type RouteHandler = NextApiHandler;

const routes: Record<string, RouteHandler> = {
  searchTest: searchTestRoute,
  internal: internalSearchRoute,
  indexCreate: indexCreateRoute,
  indexUpdate: indexUpdateRoute,
  indexDelete: indexDeleteRoute,
};

describe('Search & index routes (P5-04)', () => {
  it('API-SEARCH-001 passes collectionFilterMatch through without 501999', async () => {
    const searchTest = routes.searchTest;
    const recorder = responseRecorder();
    await searchTest(
      request({
        method: 'POST',
        url: '/api/core/dataset/searchTest',
        body: {
          datasetId: '0000000000000000000000aa',
          text: 'alpha',
          collectionFilterMatch: "{tags:{$and:['t1']}}",
        },
      }),
      recorder.response,
    );
    expect(recorder.result().status).toBe(200);
    const first = state.searchCalls[0] as SearchRequest;
    expect(first.collectionFilterMatch).toBe("{tags:{$and:['t1']}}");
  });

  it('API-SEARCH-001 requires a query (501049)', async () => {
    const searchTest = routes.searchTest;
    const recorder = responseRecorder();
    await searchTest(
      request({
        method: 'POST',
        url: '/api/core/dataset/searchTest',
        body: { datasetId: '0000000000000000000000aa' },
      }),
      recorder.response,
    );
    expect(recorder.result().status).toBe(400);
    expect((recorder.result().body as { code: number }).code).toBe(501049);
  });

  it('API-SEARCH-002 returns a bare SearchResult via subjectRef', async () => {
    const internal = routes.internal;
    const recorder = responseRecorder();
    await internal(
      request({
        method: 'POST',
        url: '/api/internal/dataset/search',
        body: {
          subjectRef: 'svc-1',
          datasetIds: ['0000000000000000000000aa'],
          textQueries: ['alpha'],
          models: { embeddingModel: 'bge-m3' },
          searchMode: 'embedding',
        },
      }),
      recorder.response,
    );
    const body = recorder.result().body as Record<string, unknown>;
    expect(recorder.result().status).toBe(200);
    expect(body.citations).toBeDefined();
    expect(body.code).toBeUndefined();
  });

  it('API-SEARCH-002 rejects an empty query with 501049', async () => {
    const internal = routes.internal;
    const recorder = responseRecorder();
    await internal(
      request({
        method: 'POST',
        url: '/api/internal/dataset/search',
        body: {
          subjectRef: 'svc-1',
          datasetIds: ['0000000000000000000000aa'],
          models: { embeddingModel: 'bge-m3' },
          searchMode: 'embedding',
        },
      }),
      recorder.response,
    );
    expect((recorder.result().body as { code: number }).code).toBe(501049);
  });

  it('API-SEARCH-002 surfaces pinned-version mismatch as 501050', async () => {
    state.runtime = buildRuntime({
      search: async () => {
        throw new ApiErrorException(
          createApiError({
            code: 501050,
            requestId: context.requestId,
            params: { field: 'versionPolicy.pinned', value: 'x', rangeOrVersion: 'y' },
          }),
        );
      },
    });
    const internal = routes.internal;
    const recorder = responseRecorder();
    await internal(
      request({
        method: 'POST',
        url: '/api/internal/dataset/search',
        body: {
          subjectRef: 'svc-1',
          datasetIds: ['0000000000000000000000aa'],
          textQueries: ['alpha'],
          models: { embeddingModel: 'bge-m3' },
          searchMode: 'embedding',
          versionPolicy: { mode: 'pinned', pinned: 'old' },
        },
      }),
      recorder.response,
    );
    expect((recorder.result().body as { code: number }).code).toBe(501050);
  });

  it('API-SEARCH-002 caps concurrent in-flight searches with 501052', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise((resolve) => {
      release = () => resolve(emptyResult());
    });
    state.runtime = buildRuntime({
      providerConcurrency: 1,
      search: async () => pending,
    });
    const internal = routes.internal;
    const body = {
      subjectRef: 'svc-1',
      datasetIds: ['0000000000000000000000aa'],
      textQueries: ['alpha'],
      models: { embeddingModel: 'bge-m3' },
      searchMode: 'embedding',
    };
    const first = responseRecorder();
    const running = internal(
      request({ method: 'POST', url: '/api/internal/dataset/search', body }),
      first.response,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = responseRecorder();
    await internal(
      request({ method: 'POST', url: '/api/internal/dataset/search', body }),
      second.response,
    );
    expect(second.result().status).toBe(429);
    expect((second.result().body as { code: number }).code).toBe(501052);
    release?.();
    await running;
  });

  it('API-IDX-001 creates a custom index and rejects system types with 501041', async () => {
    const create = routes.indexCreate;
    const ok = responseRecorder();
    await create(
      request({
        method: 'POST',
        url: '/api/core/dataset/index/create',
        body: { dataId: '0000000000000000000000aa', type: 'custom', text: 'hello' },
      }),
      ok.response,
    );
    expect(ok.result().status).toBe(200);
    expect((ok.result().body as { data: { indexId: string } }).data.indexId).toBe(
      '0000000000000000000000aa:custom',
    );

    const rejected = responseRecorder();
    await create(
      request({
        method: 'POST',
        url: '/api/core/dataset/index/create',
        body: { dataId: '0000000000000000000000aa', type: 'default', text: 'hello' },
      }),
      rejected.response,
    );
    expect(rejected.result().status).toBe(400);
    expect((rejected.result().body as { code: number }).code).toBe(501041);
  });

  it('API-IDX-002 returns a new version and surfaces CAS conflict as 501067', async () => {
    const update = routes.indexUpdate;
    const ok = responseRecorder();
    await update(
      request({
        method: 'POST',
        url: '/api/core/dataset/index/update',
        body: {
          dataId: '0000000000000000000000aa',
          indexId: '0000000000000000000000aa:custom',
          text: 'updated',
          version: 1,
        },
      }),
      ok.response,
    );
    expect(ok.result().status).toBe(200);
    expect((ok.result().body as { data: { version: number } }).data.version).toBe(2);

    const conflict = responseRecorder();
    await update(
      request({
        method: 'POST',
        url: '/api/core/dataset/index/update',
        body: {
          dataId: '0000000000000000000000aa',
          indexId: '0000000000000000000000aa:custom',
          text: 'stale',
          version: 99,
        },
      }),
      conflict.response,
    );
    expect(conflict.result().status).toBe(409);
    expect((conflict.result().body as { code: number }).code).toBe(501067);
  });

  it('API-IDX-003 deletes custom indexes and forbids system indexes with 501042', async () => {
    const remove = routes.indexDelete;
    const ok = responseRecorder();
    await remove(
      request({
        method: 'POST',
        url: '/api/core/dataset/index/delete',
        body: {
          dataId: '0000000000000000000000aa',
          indexId: '0000000000000000000000aa:custom',
          'Idempotency-Key': 'idem-1',
        },
      }),
      ok.response,
    );
    expect(ok.result().status).toBe(200);
    expect((ok.result().body as { data: { state: string } }).data.state).toBe('deleted');

    const forbidden = responseRecorder();
    await remove(
      request({
        method: 'POST',
        url: '/api/core/dataset/index/delete',
        body: {
          dataId: '0000000000000000000000aa',
          indexId: '0000000000000000000000aa:default',
          'Idempotency-Key': 'idem-2',
        },
      }),
      forbidden.response,
    );
    expect(forbidden.result().status).toBe(403);
    expect((forbidden.result().body as { code: number }).code).toBe(501042);
  });
});
