import { createKnowledgeError, type SearchRequest } from '@kb/contracts';
import { describe, expect, it } from 'vitest';
import { createSearchEngine, type SearchEngineDeps } from '../../src/index';

const context = { requestId: 'req-rerank', workspaceId: 'ws-rerank' };

function request(weights = { embedding: 0.5, rerank: 0.5 }): SearchRequest {
  return {
    requestId: context.requestId,
    workspaceId: context.workspaceId,
    memberId: 'mem-rerank',
    knowledgeSpaceIds: ['space-1'],
    textQueries: ['refund'],
    imageQueries: [],
    models: { embeddingModel: 'embedding', rerankModel: 'rerank' },
    searchMode: 'embedding',
    limit: 10,
    maxTokens: 5_000,
    similarity: 0,
    weights,
  };
}

function deps(overrides: Partial<SearchEngineDeps> = {}): SearchEngineDeps {
  return {
    vectors: {
      embRecall: async () => [
        { segmentId: 'a', sourceId: 'source-a', indexId: 'a', score: 0.9 },
        { segmentId: 'b', sourceId: 'source-b', indexId: 'b', score: 0.8 },
      ],
    },
    embedding: { embed: async () => [[1]] },
    resolveTexts: async (items) =>
      new Map(items.map((item) => [item.docId, `text-${item.segmentId}`])),
    rerank: {
      rerank: async ({ items }) =>
        [...items].reverse().map((item) => ({ id: item.id, score: item.score })),
    },
    ...overrides,
  };
}

describe('TEST-SEARCH-004-BLOCK rerank ranked-list RRF', () => {
  it('applies rerankWeight boundaries and reports rerankApplied', async () => {
    const zero = await createSearchEngine(deps()).search(
      request({ embedding: 0.5, rerank: 0 }),
      context,
    );
    expect(zero.stats.rerankApplied).toBe(true);
    const full = await createSearchEngine(deps()).search(
      request({ embedding: 0.5, rerank: 1 }),
      context,
    );
    expect(full.citations).toHaveLength(2);
    expect(full.stats.rerankApplied).toBe(true);
  });

  it('keeps original order and reports degraded on rerank timeout', async () => {
    const result = await createSearchEngine(
      deps({
        rerank: {
          rerank: async () => {
            throw createKnowledgeError({
              code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
              requestId: context.requestId,
              traceId: context.requestId,
              details: {},
            });
          },
        },
      }),
    ).search(request(), context);
    expect(result.stats.rerankApplied).toBe(false);
    expect(result.stats.usingReRank).toBe(false);
    expect(result.stats.partial).toBe(false);
    expect(result.stats.degraded).toContainEqual({
      stage: 'rerank',
      reason: 'rerank_failed',
    });
  });

  it('degrades when no rerank binding exists', async () => {
    const result = await createSearchEngine(deps({ rerank: undefined })).search(request(), context);
    expect(result.stats.degraded).toContainEqual({
      stage: 'rerank',
      reason: 'rerank_not_configured',
    });
  });

  it('rejects invalid rerank output with 502', async () => {
    await expect(
      createSearchEngine(
        deps({
          rerank: { rerank: async () => [{ id: 'a', score: Number.NaN }] },
        }),
      ).search(request(), context),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID' } },
    });
  });
});
