import { countTokens } from '@kb/chunk';
import type { SearchRequest } from '@kb/contracts';
import { describe, expect, it } from 'vitest';
import { applyTokenBudget, createSearchEngine } from '../../src/index';
import type { Candidate, SearchEngineDeps } from '../../src/index';

const context = { requestId: 'req-budget', tenant: { teamId: 'team-a', tmbId: 'tmb-a' } };

function candidate(docId: string, text: string): Candidate {
  return { docId, itemId: docId, collectionId: 'c1', score: 1, scores: [], text };
}

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    requestId: 'req-budget',
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

describe('P5-06 token budget (TEST-SEARCH-BUDGET-001 / ACC-SEARCH-006)', () => {
  it('counts tokens from candidate text via @kb/chunk (not JSON)', () => {
    const items = [candidate('a', 'hello'), candidate('b', 'world')];
    const seen: string[] = [];
    applyTokenBudget(items, 100, (text) => {
      seen.push(text);
      return 1;
    });
    expect(seen).toEqual(['hello', 'world']);
    expect(countTokens('hello world')).toBeGreaterThan(0);
  });

  it('always keeps the first candidate even when it exceeds the budget', () => {
    const items = [candidate('a', 'aaaa'), candidate('b', 'bbbb')];
    expect(applyTokenBudget(items, 1, () => 100).map((item) => item.docId)).toEqual(['a']);
  });

  it('stops before exceeding the budget', () => {
    const items = [candidate('a', 'a'), candidate('b', 'b'), candidate('c', 'c')];
    expect(applyTokenBudget(items, 2, () => 1).map((item) => item.docId)).toEqual(['a', 'b']);
  });

  it('uses maxTokens default 4000 and truncates on a tight budget', async () => {
    const per = countTokens('a');
    const deps: SearchEngineDeps = {
      vectors: {
        embRecall: async () => [
          { dataId: 'a', indexId: 'i', score: 0.9 },
          { dataId: 'b', indexId: 'i', score: 0.8 },
          { dataId: 'c', indexId: 'i', score: 0.7 },
        ],
      },
      embedding: { embed: async ({ texts }) => texts.map(() => [0.1]) },
      resolveTexts: async (candidates) =>
        new Map(candidates.map((item) => [item.docId, item.docId.slice(-1)])),
    };
    const engine = createSearchEngine(deps);

    const relaxed = await engine.search(request(), context);
    expect(relaxed.citations).toHaveLength(3);

    const tight = await engine.search(request({ maxTokens: per * 2 }), context);
    expect(tight.citations).toHaveLength(2);
  });
});
