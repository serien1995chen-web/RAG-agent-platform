import type { SearchRequest } from '@kb/contracts';
import { describe, expect, it } from 'vitest';
import { createSearchEngine, rrfFuseWeighted } from '../../src/index';
import type { SearchEngineDeps } from '../../src/index';

const context = { requestId: 'req-weights', tenant: { teamId: 'team-a', tmbId: 'tmb-a' } };

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    requestId: 'req-weights',
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
      new Map(candidates.map((candidate) => [candidate.docId, `${candidate.docId} text`])),
    ...overrides,
  };
}

describe('P5-06 weights (TEST-SEARCH-WEIGHT-001 / ACC-SEARCH-006)', () => {
  it('turns a path off with weight zero and on with weight one', () => {
    expect(
      rrfFuseWeighted([[{ id: 'a', rank: 1, weight: 0, type: 'embedding' }]]).get('a'),
    ).toEqual({ rrf: 0, bestByType: new Map([['embedding', 0]]) });
    expect(
      rrfFuseWeighted([[{ id: 'a', rank: 1, weight: 1, type: 'embedding' }]]).get('a')?.rrf,
    ).toBe(1 / 61);
  });

  it('rejects out-of-range weights with 501050', async () => {
    const engine = createSearchEngine(deps());
    await expect(
      engine.search(request({ weights: { embedding: -0.01, rerank: 0.5 } }), context),
    ).rejects.toMatchObject({ error: { code: 501050 } });
    await expect(
      engine.search(request({ weights: { embedding: 1.01, rerank: 0.5 } }), context),
    ).rejects.toMatchObject({ error: { code: 501050 } });
    await expect(
      engine.search(request({ weights: { embedding: 0.5, rerank: -0.01 } }), context),
    ).rejects.toMatchObject({ error: { code: 501050 } });
    await expect(
      engine.search(request({ weights: { embedding: 0.5, rerank: 1.01 } }), context),
    ).rejects.toMatchObject({ error: { code: 501050 } });
  });

  it('defaults to embedding 0.5 (a mutual rank-one candidate scores 1/61)', async () => {
    const shared = deps({
      vectors: { embRecall: async () => [{ dataId: 'd1', indexId: 'i1', score: 0.9 }] },
      fullText: { search: async () => [{ dataId: 'd1', collectionId: 'c1', score: 0.7 }] },
    });
    const result = await createSearchEngine(shared).search(request(), context);
    const rrfScore = result.citations[0]?.scores.find((score) => score.type === 'rrf')?.value;
    expect(rrfScore).toBe(1 / 61);
  });

  it('zero embedding weight removes the embedding contribution', async () => {
    const engine = createSearchEngine(deps());
    const result = await engine.search(
      request({ weights: { embedding: 0, rerank: 0.5 } }),
      context,
    );
    const vectorOnly = result.citations.find((citation) => citation.dataId === 'v1');
    const rrfScore = vectorOnly?.scores.find((score) => score.type === 'rrf')?.value;
    expect(rrfScore).toBe(0);
  });
});
