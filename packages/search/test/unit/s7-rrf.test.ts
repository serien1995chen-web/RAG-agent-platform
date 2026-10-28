import { createKnowledgeError, type SearchRequest } from '@kb/contracts';
import { describe, expect, it } from 'vitest';
import { createSearchEngine, rrfFuseWeighted, type SearchEngineDeps } from '../../src/index';

const context = { requestId: 'req-rrf', workspaceId: 'ws-rrf' };

function request(mode: SearchRequest['searchMode']): SearchRequest {
  return {
    requestId: context.requestId,
    workspaceId: context.workspaceId,
    memberId: 'mem-rrf',
    knowledgeSpaceIds: ['space-1'],
    textQueries: ['refund'],
    imageQueries: [],
    models: { embeddingModel: 'embedding' },
    searchMode: mode,
    limit: 10,
    maxTokens: 5_000,
    similarity: 0,
  };
}

function deps(failFullText = false): SearchEngineDeps {
  return {
    vectors: {
      embRecall: async () => [
        { segmentId: 'a', sourceId: 'source-a', indexId: 'idx-a', score: 0.9 },
      ],
    },
    fullText: {
      search: async () => {
        if (failFullText) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
            requestId: context.requestId,
            traceId: context.requestId,
            details: {},
          });
        }
        return [{ segmentId: 'a', sourceId: 'source-a', score: 0.8 }];
      },
    },
    embedding: { embed: async ({ texts }) => texts.map(() => [1]) },
    resolveTexts: async (items) => new Map(items.map((item) => [item.docId, 'same text'])),
  };
}

describe('TEST-SEARCH-002-BLOCK weighted RRF and channel outcomes', () => {
  it('uses the frozen weighted RRF contribution and stable tie break', () => {
    const fused = rrfFuseWeighted([
      [{ id: 'b', rank: 1, type: 'embedding', weight: 0.5 }],
      [{ id: 'a', rank: 1, type: 'embedding', weight: 0.5 }],
    ]);
    expect(fused.get('a')?.rrf).toBe(0.5 / 61);
    expect(fused.get('b')?.rrf).toBe(0.5 / 61);
  });

  it('returns 207 partial when one hybrid channel fails', async () => {
    const result = await createSearchEngine(deps(true)).search(request('mixedRecall'), context);
    expect(result.status).toBe(207);
    expect(result.stats.partial).toBe(true);
    expect(result.stats.degraded).toContainEqual({
      stage: 'fullText',
      reason: 'fulltext_recall_failed',
    });
    expect(result.citations).toHaveLength(1);
  });

  it('raises the all-channel failure instead of returning an empty success', async () => {
    const allFailed: SearchEngineDeps = {
      ...deps(true),
      vectors: {
        embRecall: async () => {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
            requestId: context.requestId,
            traceId: context.requestId,
            details: {},
          });
        },
      },
    };
    await expect(
      createSearchEngine(allFailed).search(request('mixedRecall'), context),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT' } },
    });
  });
});
