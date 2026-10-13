import { describe, expect, it } from 'vitest';
import type { SearchRequest } from '../../packages/contracts/src/index';
import { createSearchEngine } from '../../packages/search/src/index';
import type { SearchEngineDeps } from '../../packages/search/src/index';

const context = { requestId: 'req-rerank', tenant: { teamId: 'team-a', tmbId: 'tmb-a' } };

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    requestId: 'req-rerank',
    teamId: 'team-a',
    datasetIds: ['d1'],
    textQueries: ['alpha'],
    imageQueries: [],
    models: { embeddingModel: 'bge-m3', rerankModel: 'rerank-x' },
    searchMode: 'embedding',
    limit: 10,
    maxTokens: 4_000,
    similarity: 0,
    ...overrides,
  };
}

function engineDeps(overrides: Partial<SearchEngineDeps> = {}): SearchEngineDeps {
  return {
    vectors: { embRecall: async () => [{ dataId: 'data-1', indexId: 'idx-1', score: 0.9 }] },
    embedding: {
      embed: async ({ texts }) => texts.map(() => Array.from({ length: 1536 }, () => 0)),
    },
    resolveTexts: async (candidates) =>
      new Map(candidates.map((candidate) => [candidate.docId, `${candidate.docId} text`])),
    ...overrides,
  };
}

const failingRerank: SearchEngineDeps['rerank'] = {
  rerank: async () => {
    throw new Error('rerank_down');
  },
};

describe('P5-03 rerank failure modes', () => {
  it('TEST-SEARCH-RERANK-FALLBACK-001 / TEST-FI-RERANK-001: fallback degrades without throwing', async () => {
    const engine = createSearchEngine(engineDeps({ rerank: failingRerank }));
    const result = await engine.search(request(), context);

    expect(result.stats.usingReRank).toBe(false);
    expect(result.stats.degraded).toContainEqual({ stage: 'rerank', reason: 'rerank_down' });
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it('TEST-SEARCH-RERANK-STRICT-001 / ACC-SEARCH-007: strict throws 501064 with no degraded result', async () => {
    const engine = createSearchEngine(engineDeps({ rerank: failingRerank }), {
      rerankFailureMode: 'strict',
    });

    await expect(engine.search(request(), context)).rejects.toMatchObject({
      error: { code: 501064 },
    });
  });
});
