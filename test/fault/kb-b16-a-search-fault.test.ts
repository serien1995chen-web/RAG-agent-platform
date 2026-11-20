import { describe, expect, it } from 'vitest';
import { createKnowledgeError, type SearchRequest } from '../../packages/contracts/src/index';
import { createSearchEngine, type SearchEngineDeps } from '../../packages/search/src/index';

const context = {
  requestId: 'req-kb-b16-a-fault',
  workspaceId: 'ws-kb-b16-a-fault',
  memberId: 'mem-kb-b16-a-fault',
  scopes: ['knowledge:search'],
};

function request(): SearchRequest {
  return {
    requestId: context.requestId,
    workspaceId: context.workspaceId,
    memberId: context.memberId,
    knowledgeSpaceIds: ['space-kb-b16-a-fault'],
    textQueries: ['refund'],
    imageQueries: [],
    models: { embeddingModel: 'qwen3.7-text-embedding' },
    searchMode: 'mixedRecall',
    limit: 10,
    maxTokens: 5_000,
    similarity: 0,
  };
}

function problem(code: Parameters<typeof createKnowledgeError>[0]['code']) {
  return createKnowledgeError({
    code,
    requestId: context.requestId,
    traceId: context.requestId,
    details: {},
  });
}

function deps(input: { vectorError?: unknown; fullTextError?: unknown }): SearchEngineDeps {
  return {
    embedding: { embed: async ({ texts }) => texts.map(() => [1, 0]) },
    vectors: {
      embRecall: async () => {
        if (input.vectorError) throw input.vectorError;
        return [{ segmentId: 'seg-a', sourceId: 'src-a', indexId: 'idx-a', score: 0.9 }];
      },
    },
    fullText: {
      search: async () => {
        if (input.fullTextError) throw input.fullTextError;
        return [{ segmentId: 'seg-b', sourceId: 'src-b', score: 5 }];
      },
    },
    resolveTexts: async (items) => new Map(items.map((item) => [item.docId, item.docId])),
  };
}

describe('B16 codexA search faults', () => {
  it('L1-B16-A-SEARCH-002-F01 returns 207 and no fabricated citation for a failed full-text channel', async () => {
    const result = await createSearchEngine(
      deps({ fullTextError: problem('KNOWLEDGE_DEPENDENCY_TIMEOUT') }),
    ).search(request(), context);
    expect(result.status).toBe(207);
    expect(result.stats.partial).toBe(true);
    expect(result.stats.degraded).toContainEqual({
      stage: 'fullText',
      reason: 'fulltext_recall_failed',
    });
    expect(result.citations.map((citation) => citation.segmentId)).toEqual(['seg-a']);
  });

  it('L1-B16-A-SEARCH-002-F02 uses timeout priority when both attempted channels fail', async () => {
    await expect(
      createSearchEngine(
        deps({
          vectorError: problem('KNOWLEDGE_DEPENDENCY_UNAVAILABLE'),
          fullTextError: problem('KNOWLEDGE_DEPENDENCY_TIMEOUT'),
        }),
      ).search(request(), context),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT' } },
    });
  });

  it('L1-B16-A-SEARCH-001-F01 distinguishes provider failure from a successful empty query', async () => {
    await expect(
      createSearchEngine(deps({ vectorError: problem('KNOWLEDGE_MODEL_FAILED') })).search(
        { ...request(), searchMode: 'embedding' },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_MODEL_FAILED' } },
    });

    const empty = await createSearchEngine({
      embedding: { embed: async () => [[1]] },
      vectors: { embRecall: async () => [] },
    }).search({ ...request(), searchMode: 'embedding' }, context);
    expect(empty.status).toBe(200);
    expect(empty.citations).toEqual([]);
    expect(empty.stats.partial).toBe(false);
  });

  it('L1-B16-A-SEARCH-001-F02 recovers on a later request without embedding twice per attempt', async () => {
    let calls = 0;
    const engine = createSearchEngine({
      embedding: {
        embed: async ({ texts }) => {
          calls += 1;
          if (calls === 1) throw problem('KNOWLEDGE_DEPENDENCY_UNAVAILABLE');
          return texts.map(() => [1]);
        },
      },
      vectors: {
        embRecall: async () => [
          { segmentId: 'seg-a', sourceId: 'src-a', indexId: 'idx-a', score: 0.9 },
        ],
      },
      resolveTexts: async (items) => new Map(items.map((item) => [item.docId, item.docId])),
    });
    await expect(
      engine.search({ ...request(), searchMode: 'embedding' }, context),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' } },
    });
    const recovered = await engine.search({ ...request(), searchMode: 'embedding' }, context);
    expect(recovered.citations).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('L1-B16-A-SEARCH-004-F02 does not retry unauthorized rerank and applies no fallback call', async () => {
    let rerankCalls = 0;
    await expect(
      createSearchEngine({
        embedding: { embed: async () => [[1]] },
        vectors: {
          embRecall: async () => [
            { segmentId: 'seg-a', sourceId: 'src-a', indexId: 'idx-a', score: 0.9 },
          ],
        },
        resolveTexts: async (items) => new Map(items.map((item) => [item.docId, item.docId])),
        rerank: {
          rerank: async () => {
            rerankCalls += 1;
            throw problem('KNOWLEDGE_FORBIDDEN');
          },
        },
      }).search(
        {
          ...request(),
          searchMode: 'embedding',
          models: {
            embeddingModel: 'qwen3.7-text-embedding',
            rerankModel: 'qwen3.7-text-rerank',
          },
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    expect(rerankCalls).toBe(1);
  });
});
