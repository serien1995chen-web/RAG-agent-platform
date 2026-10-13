import type { SearchRequest, SearchResult } from '../../packages/contracts/src/index';
import { createSearchEngine } from '../../packages/search/src/index';
import type { SearchEngineDeps } from '../../packages/search/src/index';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import searchTestRoute from '../../projects/app/src/pages/api/core/dataset/searchTest';
import internalSearchRoute from '../../projects/app/src/pages/api/internal/dataset/search';

const context = {
  requestId: 'req-search-e2e',
  tenant: {
    teamId: 'team-a',
    tmbId: '000000000000000000000002',
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const state = vi.hoisted(() => ({ runtime: undefined as unknown }));
vi.mock('../../projects/app/src/runtime/health', () => ({ getRuntime: async () => state.runtime }));
vi.mock('../../projects/app/src/runtime', () => ({ getRuntime: async () => state.runtime }));

function resultWith(degraded: { stage: string; reason: string }[]): SearchResult {
  return {
    citations: [
      {
        dataId: '0000000000000000000000aa',
        chunkIndex: 0,
        datasetId: '0000000000000000000000bb',
        collectionId: '0000000000000000000000cc',
        collectionName: 'source.txt',
        sourceName: 'source.txt',
        sourceType: 'file',
        quoteText: 'alpha',
        updateTime: '2026-01-01T00:00:00.000Z',
        scores: [{ type: 'rrf', value: 1 / 61, index: 0 }],
      },
    ],
    stats: {
      searchMode: 'embedding',
      usingReRank: false,
      usingSimilarityFilter: false,
      embeddingTokens: 1,
      rerankInputTokens: 0,
      degraded,
      durationMs: 1,
    },
  };
}

function failingRerankDeps(): SearchEngineDeps {
  return {
    vectors: { embRecall: async () => [{ dataId: 'd1', indexId: 'i1', score: 0.9 }] },
    embedding: { embed: async ({ texts }) => texts.map(() => [0.1]) },
    rerank: {
      rerank: async () => {
        throw new Error('rerank_down');
      },
    },
    resolveTexts: async (candidates) => new Map(candidates.map((item) => [item.docId, 'text'])),
  };
}

function buildRuntime(search: (request: SearchRequest) => Promise<SearchResult>) {
  return {
    config: { capacity: { providerConcurrency: 4 } },
    extensions: {
      get: (id: string) => (id === 'identity' ? { resolve: async () => context.tenant } : null),
    },
    datasetApi: {
      getDatasetDetail: async () => ({
        dataset: { datasetId: '0000000000000000000000bb', vectorModel: 'bge-m3' },
        stats: { collections: 0, datas: 0 },
      }),
    },
    datasetSearch: { search: async (request: SearchRequest) => search(request) },
  };
}

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

function request(body: unknown): NextApiRequest {
  return {
    method: 'POST',
    url: '/api/internal/dataset/search',
    query: {},
    body,
    headers: {},
  } as unknown as NextApiRequest;
}

async function call(handler: NextApiHandler, body: unknown) {
  const recorder = responseRecorder();
  await handler(request(body), recorder.response);
  return recorder.result();
}

const internalBody = (overrides: Record<string, unknown> = {}) => ({
  subjectRef: 'svc-1',
  datasetIds: ['0000000000000000000000bb'],
  textQueries: ['alpha'],
  models: { embeddingModel: 'bge-m3' },
  searchMode: 'embedding',
  ...overrides,
});

beforeEach(() => {
  state.runtime = buildRuntime(async () => resultWith([]));
});

describe('P5-07 search e2e (TEST-API-SCHEMA-001 / ACC-SEARCH-005)', () => {
  it('API-SEARCH-001 records degraded stats and never leaks internal keys', async () => {
    state.runtime = buildRuntime(async () =>
      resultWith([{ stage: 'fullText', reason: 'full_text_store_unavailable' }]),
    );
    const recorder = responseRecorder();
    await searchTestRoute(
      {
        method: 'POST',
        url: '/api/core/dataset/searchTest',
        query: {},
        body: { datasetId: '0000000000000000000000bb', text: 'alpha' },
        headers: {},
      } as unknown as NextApiRequest,
      recorder.response,
    );
    const body = recorder.result().body as {
      data: { searchRes: SearchResult };
    };
    expect(recorder.result().status).toBe(200);
    expect(body.data.searchRes.stats.degraded).toHaveLength(1);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('imageId');
    expect(serialized).not.toContain('objectKey');
  });

  it('API-SEARCH-002 resolves the subject and returns a bare SearchResult', async () => {
    state.runtime = buildRuntime(async () => resultWith([]));
    const result = await call(internalSearchRoute, internalBody());
    const body = result.body as Record<string, unknown>;
    expect(result.status).toBe(200);
    expect(body.citations).toBeDefined();
    expect(body.code).toBeUndefined();
  });

  it('S04 strict rerank failure returns 501064 end-to-end', async () => {
    const engine = createSearchEngine(failingRerankDeps(), { rerankFailureMode: 'strict' });
    state.runtime = buildRuntime(async (request) => engine.search(request, context));
    const result = await call(
      internalSearchRoute,
      internalBody({ models: { embeddingModel: 'bge-m3', rerankModel: 'r1' } }),
    );
    expect(result.status).toBe(503);
    expect((result.body as { code: number }).code).toBe(501064);
  });

  it('S04 fallback rerank failure degrades with usingReRank=false', async () => {
    const engine = createSearchEngine(failingRerankDeps());
    state.runtime = buildRuntime(async (request) => engine.search(request, context));
    const result = await call(
      internalSearchRoute,
      internalBody({ models: { embeddingModel: 'bge-m3', rerankModel: 'r1' } }),
    );
    const body = result.body as SearchResult;
    expect(result.status).toBe(200);
    expect(body.stats.usingReRank).toBe(false);
    expect(body.stats.degraded).toContainEqual({ stage: 'rerank', reason: 'rerank_down' });
  });
});
