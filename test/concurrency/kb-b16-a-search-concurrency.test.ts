import { describe, expect, it } from 'vitest';
import { createSearchEngine, type SearchEngineDeps } from '../../packages/search/src/index';

function request(workspaceId: string, spaceId: string, query: string) {
  return {
    requestId: `req-${workspaceId}`,
    workspaceId,
    memberId: `mem-${workspaceId}`,
    knowledgeSpaceIds: [spaceId],
    textQueries: [query],
    imageQueries: [],
    models: { embeddingModel: 'qwen3.7-text-embedding' },
    searchMode: 'embedding' as const,
    limit: 10,
    maxTokens: 5_000,
    similarity: 0,
  };
}

describe('B16 codexA search concurrency', () => {
  it('L1-B16-A-SEARCH-001-C01 isolates simultaneous tenant candidates and request IDs', async () => {
    const deps: SearchEngineDeps = {
      embedding: { embed: async ({ texts }) => texts.map(() => [1, 0]) },
      vectors: {
        embRecall: async (input, context) => [
          {
            segmentId: `segment-${context.workspaceId}`,
            sourceId: `source-${context.workspaceId}`,
            indexId: `index-${context.workspaceId}`,
            score: input.knowledgeSpaceId === 'space-a' ? 0.9 : 0.8,
          },
        ],
      },
      hydrator: {
        hydrate: async (items, context) => ({
          rejected: 0,
          items: items.map((item, index) => ({
            ...item,
            segmentId: item.segmentId!,
            sourceId: item.sourceId!,
            text: `${context.workspaceId}:${item.segmentId}`,
            segment: {
              id: item.segmentId!,
              workspaceId: context.workspaceId,
              knowledgeSpaceId: item.knowledgeSpaceId,
              sourceId: item.sourceId!,
              sourceVersion: 1,
              order: index,
              searchEnabled: true,
              question: '',
              answer: '',
              content: `${context.workspaceId}:${item.segmentId}`,
              metadata: {},
              indexes: [],
              indexStatus: 'indexed' as const,
              indexErrorCode: null,
              imageBlobRefId: null,
              version: 1,
            },
            source: {
              id: item.sourceId!,
              workspaceId: context.workspaceId,
              knowledgeSpaceId: item.knowledgeSpaceId,
              name: `Source ${context.workspaceId}`,
              originalUrl: null,
              sourceVersion: 1,
              permissionRevision: 1,
              searchEnabled: true,
              deletedAt: null,
            },
          })),
        }),
      },
    };
    const engine = createSearchEngine(deps);
    const [tenantA, tenantB] = await Promise.all([
      engine.search(request('workspace-a', 'space-a', 'refund'), {
        requestId: 'req-workspace-a',
        workspaceId: 'workspace-a',
        scopes: ['knowledge:search'],
      }),
      engine.search(request('workspace-b', 'space-b', 'refund'), {
        requestId: 'req-workspace-b',
        workspaceId: 'workspace-b',
        scopes: ['knowledge:search'],
      }),
    ]);
    expect(tenantA.authorizedCandidates.map((item) => item.source.workspaceId)).toEqual([
      'workspace-a',
    ]);
    expect(tenantB.authorizedCandidates.map((item) => item.source.workspaceId)).toEqual([
      'workspace-b',
    ]);
    expect(tenantA.citations[0]?.citationId).not.toBe(tenantB.citations[0]?.citationId);
  });

  it('L1-B16-A-SEARCH-004-C01 isolates concurrent rerank batches by workspace', async () => {
    const seen: string[][] = [];
    const deps: SearchEngineDeps = {
      embedding: { embed: async () => [[1]] },
      vectors: {
        embRecall: async (_input, context) => [
          {
            segmentId: `seg-${context.workspaceId}`,
            sourceId: `src-${context.workspaceId}`,
            indexId: `idx-${context.workspaceId}`,
            score: 0.5,
          },
        ],
      },
      resolveTexts: async (items) => new Map(items.map((item) => [item.docId, item.docId])),
      rerank: {
        rerank: async ({ items }, context) => {
          seen.push(items.map((item) => `${context.workspaceId}:${item.id}`));
          return items.map((item) => ({ id: item.id, score: 1 }));
        },
      },
    };
    const engine = createSearchEngine(deps);
    const base = request('workspace-a', 'space-a', 'query');
    await Promise.all([
      engine.search(
        { ...base, models: { ...base.models, rerankModel: 'qwen3.7-text-rerank' } },
        { requestId: 'request-a', workspaceId: 'workspace-a', scopes: ['knowledge:search'] },
      ),
      engine.search(
        {
          ...base,
          requestId: 'request-b',
          workspaceId: 'workspace-b',
          models: { ...base.models, rerankModel: 'qwen3.7-text-rerank' },
        },
        { requestId: 'request-b', workspaceId: 'workspace-b', scopes: ['knowledge:search'] },
      ),
    ]);
    expect(seen).toHaveLength(2);
    for (const batch of seen) {
      const workspaces = new Set(batch.map((entry) => entry.split(':')[0]));
      expect(workspaces.size).toBe(1);
    }
  });
});
