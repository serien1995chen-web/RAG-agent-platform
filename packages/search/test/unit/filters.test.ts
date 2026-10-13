import type { SearchRequest } from '@kb/contracts';
import { describe, expect, it } from 'vitest';
import { createSearchEngine, parseCollectionFilterMatch } from '../../src/index';
import type { SearchEngineDeps } from '../../src/index';

const context = { requestId: 'req-filters', tenant: { teamId: 'team-a', tmbId: 'tmb-a' } };

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    requestId: 'req-filters',
    teamId: 'team-a',
    datasetIds: ['ds1'],
    textQueries: ['alpha'],
    imageQueries: [],
    models: { embeddingModel: 'bge-m3' },
    searchMode: 'embedding',
    limit: 10,
    maxTokens: 4_000,
    similarity: 0,
    ...overrides,
  };
}

const deps: SearchEngineDeps = {
  vectors: { embRecall: async () => [{ dataId: 'd1', indexId: 'i1', score: 0.9 }] },
  embedding: { embed: async ({ texts }) => texts.map(() => [0.1]) },
  resolveTexts: async (candidates) =>
    new Map(candidates.map((candidate) => [candidate.docId, `${candidate.docId} text`])),
};

describe('P5-06 collection filter / batch (TEST-SEARCH-FILTER-001 / ACC-SEARCH-006)', () => {
  it('maps tags.$and / tags.$or to tagIds', () => {
    expect(parseCollectionFilterMatch("{tags:{$and:['t1','t2']}}")).toEqual({
      matched: true,
      tagsAnd: ['t1', 't2'],
      tagsOr: [],
    });
    expect(parseCollectionFilterMatch("{tags:{$or:['t1','t2']}}")).toEqual({
      matched: true,
      tagsAnd: [],
      tagsOr: ['t1', 't2'],
    });
  });

  it('treats null in $and as matched=false and drops null from $or', () => {
    expect(parseCollectionFilterMatch("{tags:{$and:['t1',null]}}")).toEqual({
      matched: false,
      tagsAnd: [],
      tagsOr: [],
    });
    expect(parseCollectionFilterMatch("{tags:{$or:['t1',null,'t2']}}")).toEqual({
      matched: true,
      tagsAnd: [],
      tagsOr: ['t1', 't2'],
    });
  });

  it('rejects illegal keys/operators with 501050', () => {
    expect(() => parseCollectionFilterMatch("{tags:{$not:['t1']}}")).toThrowError();
    expect(() => parseCollectionFilterMatch('{other:1}')).toThrowError();
    try {
      parseCollectionFilterMatch("{tags:{$not:['t1']}}");
    } catch (error) {
      expect((error as { error: { code: number } }).error.code).toBe(501050);
    }
  });

  it('rejects searchBatch over ten requests with 501050', async () => {
    const engine = createSearchEngine(deps);
    await expect(
      engine.searchBatch(
        Array.from({ length: 11 }, () => request()),
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501050 } });
  });

  it('degrades a single failing batch item with stage=request', async () => {
    const engine = createSearchEngine(deps);
    const results = await engine.searchBatch(
      [request(), request({ textQueries: [], imageQueries: [] })],
      context,
    );
    expect(results[1]?.citations).toEqual([]);
    expect(results[1]?.stats.degraded[0]?.stage).toBe('request');
  });
});
