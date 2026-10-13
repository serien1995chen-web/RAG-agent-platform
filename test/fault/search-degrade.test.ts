import type { SearchRequest } from '../../packages/contracts/src/index';
import { describe, expect, it } from 'vitest';
import { createSearchEngine } from '../../packages/search/src/index';
import type { SearchEngineDeps } from '../../packages/search/src/index';

const context = { requestId: 'req-degrade', tenant: { teamId: 'team-a', tmbId: 'tmb-a' } };

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    requestId: 'req-degrade',
    teamId: 'team-a',
    datasetIds: ['ds1'],
    textQueries: ['alpha'],
    imageQueries: [],
    models: { embeddingModel: 'bge-m3' },
    searchMode: 'mixedRecall',
    limit: 10,
    maxTokens: 4_000,
    similarity: 0,
    ...overrides,
  };
}

function deps(overrides: Partial<SearchEngineDeps> = {}): SearchEngineDeps {
  return {
    vectors: { embRecall: async () => [{ dataId: 'v1', indexId: 'i1', score: 0.9 }] },
    fullText: { search: async () => [{ dataId: 'f1', collectionId: 'c1', score: 0.7 }] },
    embedding: { embed: async ({ texts }) => texts.map(() => [0.1]) },
    resolveTexts: async (candidates) =>
      new Map(candidates.map((item) => [item.docId, `${item.docId} text`])),
    ...overrides,
  };
}

describe('P5-07 degraded search (TEST-SEARCH-DEGRADE-001 / ACC-SEARCH-002)', () => {
  it('keeps the full-text path when the vector path fails', async () => {
    const engine = createSearchEngine(
      deps({
        vectors: {
          embRecall: async () => {
            throw new Error('vector_down');
          },
        },
      }),
    );
    const result = await engine.search(request(), context);
    expect(result.stats.degraded).toContainEqual({ stage: 'vector', reason: 'vector_down' });
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it('keeps the vector path when the full-text path fails', async () => {
    const engine = createSearchEngine(
      deps({
        fullText: {
          search: async () => {
            throw new Error('fulltext_down');
          },
        },
      }),
    );
    const result = await engine.search(request(), context);
    expect(result.stats.degraded).toContainEqual({ stage: 'fullText', reason: 'fulltext_down' });
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it('records the image path as image_path_not_configured', async () => {
    const result = await createSearchEngine(deps()).search(
      request({ imageQueries: [{ url: 'https://example.com/a.png' }] }),
      context,
    );
    expect(result.stats.degraded).toContainEqual({
      stage: 'image',
      reason: 'image_path_not_configured',
    });
  });

  it('records an unconfigured rerank dependency', async () => {
    const result = await createSearchEngine(deps()).search(
      request({ models: { embeddingModel: 'bge-m3', rerankModel: 'r1' } }),
      context,
    );
    expect(result.stats.degraded).toContainEqual({
      stage: 'rerank',
      reason: 'rerank_not_configured',
    });
  });

  it('returns an empty result with degraded stages when every path fails', async () => {
    const engine = createSearchEngine(
      deps({
        vectors: {
          embRecall: async () => {
            throw new Error('vector_down');
          },
        },
        fullText: {
          search: async () => {
            throw new Error('fulltext_down');
          },
        },
      }),
    );
    const result = await engine.search(request(), context);
    expect(result.citations).toEqual([]);
    expect(result.stats.degraded.map((item) => item.stage).sort()).toEqual(['fullText', 'vector']);
  });

  it('degrades a single failing batch item with stage=request', async () => {
    const engine = createSearchEngine(deps());
    const results = await engine.searchBatch(
      [request(), request({ textQueries: [], imageQueries: [] })],
      context,
    );
    expect(results[1]?.stats.degraded[0]?.stage).toBe('request');
  });
});
