import type { SearchRequest } from '@kb/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RRF_K, createSearchEngine, mergeReranked, rrfFuseWeighted } from '../../src/index';
import type { Candidate, SearchEngineDeps } from '../../src/index';

const context = { requestId: 'req-candidates', tenant: { teamId: 'team-a', tmbId: 'tmb-a' } };

function candidate(docId: string, score: number): Candidate {
  return { docId, itemId: docId, collectionId: 'c1', score, scores: [], text: docId };
}

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    requestId: 'req-candidates',
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

describe('P5-06 candidate counts / RRF / rerank merge', () => {
  it('uses the frozen candidate counts 100/100/80+60', async () => {
    const vectorLimits: number[] = [];
    const fullTextLimits: number[] = [];
    const deps: SearchEngineDeps = {
      vectors: {
        embRecall: async (input) => {
          vectorLimits.push(input.limit);
          return [];
        },
      },
      fullText: {
        search: async (input) => {
          fullTextLimits.push(input.limit);
          return [];
        },
      },
      embedding: { embed: async ({ texts }) => texts.map(() => [0.1]) },
    };
    const engine = createSearchEngine(deps);

    await engine.search(request({ searchMode: 'embedding' }), context);
    expect(vectorLimits).toEqual([100]);
    expect(fullTextLimits).toEqual([]);

    vectorLimits.length = 0;
    await engine.search(request({ searchMode: 'fullTextRecall' }), context);
    expect(vectorLimits).toEqual([]);
    expect(fullTextLimits).toEqual([100]);

    vectorLimits.length = 0;
    fullTextLimits.length = 0;
    await engine.search(request({ searchMode: 'mixedRecall' }), context);
    expect(vectorLimits).toEqual([80]);
    expect(fullTextLimits).toEqual([60]);
  });

  it('freezes the RRF formula weight x 1/(60+rank)', () => {
    expect(DEFAULT_RRF_K).toBe(60);
    expect(
      rrfFuseWeighted([[{ id: 'a', rank: 1, weight: 1, type: 'embedding' }]]).get('a')?.rrf,
    ).toBe(1 / 61);
    expect(
      rrfFuseWeighted([
        [{ id: 'a', rank: 1, weight: 1, type: 'embedding' }],
        [{ id: 'a', rank: 1, weight: 1, type: 'fullText' }],
        [{ id: 'a', rank: 1, weight: 1, type: 'image' }],
      ]).get('a')?.rrf,
    ).toBe(3 / 61);
  });

  it('merges reranked subsets with (1-r) and drops unselected ids at r=1', () => {
    const original = [candidate('a', 0.4), candidate('b', 0.6)];
    const merged = mergeReranked(original, [{ id: 'a', score: 1 }], 0.5);
    const byId = new Map(merged.items.map((item) => [item.docId, item.score]));
    expect(byId.get('a')).toBe(0.7);
    expect(byId.get('b')).toBe(0.3);
    expect(merged.ignored).toBe(0);

    const dropped = mergeReranked(original, [{ id: 'a', score: 1 }], 1);
    expect(dropped.items.map((item) => item.docId)).toEqual(['a']);
  });

  it('takes the max score for duplicate ids and counts unknown ids as ignored', () => {
    const original = [candidate('a', 0), candidate('b', 0)];
    const merged = mergeReranked(
      original,
      [
        { id: 'a', score: 0.2 },
        { id: 'a', score: 0.9 },
        { id: 'z', score: 1 },
      ],
      1,
    );
    const byId = new Map(merged.items.map((item) => [item.docId, item.score]));
    expect(byId.get('a')).toBe(0.9);
    expect(merged.ignored).toBe(1);
  });

  it('defaults rerank r to 0.5 in the engine', async () => {
    const baselineDeps: SearchEngineDeps = {
      vectors: { embRecall: async () => [{ dataId: 'd1', indexId: 'i1', score: 0.9 }] },
      embedding: { embed: async ({ texts }) => texts.map(() => [0.1]) },
      resolveTexts: async (candidates) => new Map(candidates.map((item) => [item.docId, 'text'])),
    };
    const baseline = await createSearchEngine(baselineDeps).search(request(), context);
    const base = baseline.citations[0]?.scores.find((score) => score.type === 'rrf')?.value ?? 0;

    const reranked = await createSearchEngine({
      ...baselineDeps,
      rerank: { rerank: async ({ items }) => items.map((item) => ({ id: item.id, score: 1 })) },
    }).search(request({ models: { embeddingModel: 'bge-m3', rerankModel: 'r1' } }), context);

    expect(reranked.stats.usingReRank).toBe(true);
    const blended = reranked.citations[0]?.scores.find((score) => score.type === 'rrf')?.value ?? 0;
    expect(blended).toBeCloseTo(0.5 * base + 0.5 * 1, 8);
  });
});
