import { createKnowledgeError, SearchBudgetsSchema, type SearchRequest } from '@kb/contracts';
import { describe, expect, it } from 'vitest';
import {
  createSearchEngine,
  finalizeSearchCandidates,
  rrfFuseWeighted,
  type AuthorizedCandidate,
  type SearchEngineDeps,
} from '../../src/index';

const context = {
  requestId: 'req-kb-b16-a',
  workspaceId: 'ws-kb-b16-a',
  memberId: 'mem-kb-b16-a',
  scopes: ['knowledge:search'],
};

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    requestId: context.requestId,
    workspaceId: context.workspaceId,
    memberId: context.memberId,
    knowledgeSpaceIds: ['space-kb-b16-a'],
    textQueries: ['refund matrix'],
    imageQueries: [],
    models: { embeddingModel: 'qwen3.7-text-embedding' },
    searchMode: 'mixedRecall',
    limit: 10,
    maxTokens: 5_000,
    similarity: 0,
    weights: { embedding: 0.5, rerank: 0.5 },
    ...overrides,
  };
}

function deps(overrides: Partial<SearchEngineDeps> = {}): SearchEngineDeps {
  return {
    vectors: {
      embRecall: async () => [
        { segmentId: 'seg-a', sourceId: 'src-a', indexId: 'idx-a', version: 1, score: 0.93 },
        { segmentId: 'seg-b', sourceId: 'src-b', indexId: 'idx-b', version: 1, score: 0.81 },
      ],
    },
    fullText: {
      search: async () => [
        { segmentId: 'seg-b', sourceId: 'src-b', fullTextVersion: 4, score: 7.2 },
        { segmentId: 'seg-c', sourceId: 'src-c', fullTextVersion: 4, score: 5.1 },
      ],
    },
    embedding: { embed: async ({ texts }) => texts.map(() => [1, 0, 0]) },
    resolveTexts: async (items) =>
      new Map(items.map((item) => [item.docId, `authorized text ${item.segmentId}`])),
    ...overrides,
  };
}

function authorized(docId: string, score: number, text = `text-${docId}`): AuthorizedCandidate {
  const segmentId = docId.split(':').at(-1)!;
  return {
    docId,
    segmentId,
    sourceId: `source-${segmentId}`,
    knowledgeSpaceId: 'space-kb-b16-a',
    score,
    embeddingScore: score,
    scores: [{ type: 'embedding', value: score, index: 0 }],
    text,
    segment: {
      id: segmentId,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: 'space-kb-b16-a',
      sourceId: `source-${segmentId}`,
      sourceVersion: 1,
      order: 0,
      searchEnabled: true,
      question: '',
      answer: '',
      content: text,
      metadata: {},
      indexes: [],
      indexStatus: 'indexed',
      indexErrorCode: null,
      imageBlobRefId: null,
      version: 1,
    },
    source: {
      id: `source-${segmentId}`,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: 'space-kb-b16-a',
      name: `Source ${segmentId}`,
      originalUrl: null,
      sourceVersion: 1,
      permissionRevision: 1,
      searchEnabled: true,
      deletedAt: null,
    },
  };
}

describe('B16 codexA core fusion', () => {
  it('L1-B16-A-SEARCH-001-P01 uses the frozen semantic candidate limit of 100', async () => {
    const limits: number[] = [];
    await createSearchEngine(
      deps({
        vectors: {
          embRecall: async (input) => {
            limits.push(input.limit);
            return [];
          },
        },
        fullText: undefined,
      }),
    ).search(request({ searchMode: 'embedding' }), context);
    expect(limits).toEqual([100]);
  });

  it('L1-B16-A-SEARCH-002-P01 uses 80 vector plus 60 full-text and exact weighted RRF', async () => {
    const limits: Array<[string, number]> = [];
    const result = await createSearchEngine(
      deps({
        vectors: {
          embRecall: async (input) => {
            limits.push(['embedding', input.limit]);
            return [{ segmentId: 'same', sourceId: 'src-1', indexId: 'idx-1', score: 0.9 }];
          },
        },
        fullText: {
          search: async (input) => {
            limits.push(['fullText', input.limit]);
            return [{ segmentId: 'same', sourceId: 'src-1', score: 8 }];
          },
        },
      }),
    ).search(request(), context);
    expect(limits).toEqual([
      ['embedding', 80],
      ['fullText', 60],
    ]);
    expect(result.authorizedCandidates).toHaveLength(1);
    expect(result.citations[0]?.scores.find((entry) => entry.type === 'rrf')?.value).toBeCloseTo(
      1 / 61,
      12,
    );
  });

  it('L1-B16-A-SEARCH-002-A01 applies zero and one weights without widening candidates', () => {
    const vectorOnly = rrfFuseWeighted([
      [{ id: 'vector-only', rank: 1, weight: 0, type: 'embedding' }],
    ]).get('vector-only')?.rrf;
    const fullTextOnly = rrfFuseWeighted([
      [{ id: 'fulltext-only', rank: 1, weight: 1, type: 'fullText' }],
    ]).get('fulltext-only')?.rrf;
    expect(vectorOnly).toBe(0);
    expect(fullTextOnly).toBe(1 / 61);
  });

  it('L1-B16-A-SEARCH-002-C01 produces deterministic ties', async () => {
    const make = (segments: Array<[string, string]>) =>
      createSearchEngine(
        deps({
          vectors: {
            embRecall: async () =>
              segments.map(([segmentId, sourceId]) => ({
                segmentId,
                sourceId,
                indexId: `idx-${segmentId}`,
                score: 0.5,
              })),
          },
          fullText: undefined,
        }),
      ).search(request({ searchMode: 'embedding' }), context);
    const first = await make([
      ['seg-z', 'src-z'],
      ['seg-a', 'src-a'],
    ]);
    const second = await make([
      ['seg-a', 'src-a'],
      ['seg-z', 'src-z'],
    ]);
    expect(first.authorizedCandidates.map((item) => item.segmentId)).toEqual(['seg-a', 'seg-z']);
    expect(second.authorizedCandidates.map((item) => item.segmentId)).toEqual(['seg-a', 'seg-z']);
  });

  it('L1-B16-A-SEARCH-004-P01 changes order with real-like rerank evidence while retaining content', async () => {
    const baseline = await createSearchEngine(deps()).search(
      request({ searchMode: 'embedding' }),
      context,
    );
    const reranked = await createSearchEngine(
      deps({
        rerank: {
          rerank: async ({ items }) =>
            [...items].reverse().map((item, index) => ({
              id: item.id,
              score: 1 - index * 0.1,
            })),
        },
      }),
    ).search(
      request({
        searchMode: 'embedding',
        models: {
          embeddingModel: 'qwen3.7-text-embedding',
          rerankModel: 'qwen3.7-text-rerank',
        },
        weights: { embedding: 0.5, rerank: 1 },
      }),
      context,
    );
    expect(baseline.authorizedCandidates.map((item) => item.segmentId)).toEqual(['seg-a', 'seg-b']);
    expect(reranked.authorizedCandidates.map((item) => item.segmentId)).toEqual(['seg-b', 'seg-a']);
    expect(reranked.stats.rerankApplied).toBe(true);
    expect(
      new Map(reranked.authorizedCandidates.map((item) => [item.segmentId, item.text])),
    ).toEqual(new Map(baseline.authorizedCandidates.map((item) => [item.segmentId, item.text])));
  });

  it('L1-B16-A-SEARCH-004-N01 rejects invalid weights and invalid rerank output', async () => {
    await expect(
      createSearchEngine(deps()).search(
        request({ weights: { embedding: -0.01, rerank: 0.5 } }),
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    await expect(
      createSearchEngine(
        deps({ rerank: { rerank: async () => [{ id: 'seg-a', score: Number.NaN }] } }),
      ).search(
        request({
          searchMode: 'embedding',
          models: {
            embeddingModel: 'qwen3.7-text-embedding',
            rerankModel: 'qwen3.7-text-rerank',
          },
        }),
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID' } },
    });
  });

  it('L1-B16-A-SEARCH-004-Q01 uses the FastGPT-aligned 30 second rerank timeout', async () => {
    expect(SearchBudgetsSchema.parse({}).rerankTimeoutMs).toBe(30_000);
    const timeouts: number[] = [];
    const run = (rerankTimeoutMs?: number) =>
      createSearchEngine(
        deps({
          rerank: {
            rerank: async (input) => {
              timeouts.push(input.options.timeoutMs);
              return [];
            },
          },
        }),
      ).search(
        request({
          searchMode: 'embedding',
          models: {
            embeddingModel: 'qwen3.7-text-embedding',
            rerankModel: 'qwen3.7-text-rerank',
          },
          ...(rerankTimeoutMs
            ? {
                budgets: {
                  totalTimeoutMs: 30_000,
                  recallTimeoutMs: 5_000,
                  rerankTimeoutMs,
                },
              }
            : {}),
        }),
        context,
      );
    await run();
    await run(15_000);
    expect(timeouts).toEqual([30_000, 15_000]);
  });

  it('L1-B16-A-SEARCH-004-F01 preserves baseline order and emits degraded on rerank failure', async () => {
    const result = await createSearchEngine(
      deps({
        rerank: {
          rerank: async () => {
            throw createKnowledgeError({
              code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
              requestId: context.requestId,
              traceId: context.requestId,
              details: { dependency: 'rerank' },
            });
          },
        },
      }),
    ).search(
      request({
        searchMode: 'embedding',
        models: {
          embeddingModel: 'qwen3.7-text-embedding',
          rerankModel: 'qwen3.7-text-rerank',
        },
      }),
      context,
    );
    expect(result.authorizedCandidates.map((item) => item.segmentId)).toEqual(['seg-a', 'seg-b']);
    expect(result.stats.rerankApplied).toBe(false);
    expect(result.stats.degraded).toContainEqual({ stage: 'rerank', reason: 'rerank_failed' });
  });

  it('L1-B16-A-SEARCH-004-S01 finalization deduplicates identical content without rewriting citation text', () => {
    const requestValue = request({ searchMode: 'embedding', maxTokens: 5_000 });
    const candidateA = authorized('space:seg-a', 0.9, 'duplicate body');
    const candidateB = authorized('space:seg-b', 0.8, 'duplicate body');
    const result = finalizeSearchCandidates(requestValue, [candidateA, candidateB], false);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.segment?.content).toBe('duplicate body');
    expect(result.items[0]?.citationRange).toEqual({ start: 0, end: 14 });
  });
});
