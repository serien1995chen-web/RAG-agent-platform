import type { SearchRequest } from '@kb/contracts';
import { SearchFilterApiSchema } from '@kb/contracts';
import { describe, expect, it } from 'vitest';
import { compileSearchFilter, createSearchEngine } from '../../src/index';
import type { SearchEngineDeps } from '../../src/index';

const context = { requestId: 'req-filters', workspaceId: 'ws-a' };

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    requestId: 'req-filters',
    workspaceId: 'ws-a',
    memberId: 'mem-a',
    knowledgeSpaceIds: ['space-1'],
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
  vectors: {
    embRecall: async () => [{ segmentId: 'd1', sourceId: 'src-1', indexId: 'i1', score: 0.9 }],
  },
  embedding: { embed: async ({ texts }) => texts.map(() => [0.1]) },
  resolveTexts: async (candidates) =>
    new Map(candidates.map((candidate) => [candidate.docId, `${candidate.docId} text`])),
};

describe('P5-06 collection filter / batch (TEST-SEARCH-FILTER-001 / ACC-SEARCH-006)', () => {
  it('compiles typed tag conditions to a source allowlist', () => {
    const filter = SearchFilterApiSchema.parse({
      logic: 'AND',
      conditions: [
        {
          tagId: '65f1e5b2a1c9d4b7e8f0aaaa',
          tagType: 'string',
          operator: '$eq',
          value: 'support',
        },
      ],
    });
    const result = compileSearchFilter(
      filter,
      [
        {
          sourceId: '65f1e5b2a1c9d4b7e8f01111',
          knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
          directoryId: null,
          directoryPath: [],
          createdAt: new Date('2026-01-01T00:00:00Z'),
          tagValues: [
            {
              tagId: '65f1e5b2a1c9d4b7e8f0aaaa',
              valueKey: 'support',
              value: 'support',
            },
          ],
        },
      ],
      [
        {
          tagId: '65f1e5b2a1c9d4b7e8f0aaaa',
          knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
          tagType: 'string',
          status: 'active',
        },
      ],
    );
    expect(result.allowedSourceIds).toEqual(['65f1e5b2a1c9d4b7e8f01111']);
  });

  it('rejects unsupported attribute values without coercion', () => {
    expect(
      SearchFilterApiSchema.safeParse({
        logic: 'AND',
        conditions: [
          {
            tagId: '65f1e5b2a1c9d4b7e8f0aaaa',
            tagType: 'number',
            operator: '$contains',
            value: '1',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown filter fields and legacy free-form objects', () => {
    expect(
      SearchFilterApiSchema.safeParse({
        logic: 'AND',
        conditions: [],
        tagFilterMatch: "{tags:{$and:['t1']}}",
      }).success,
    ).toBe(false);
    expect(
      SearchFilterApiSchema.safeParse({
        logic: 'AND',
        conditions: [],
        nested: { tags: ['t1'] },
      }).success,
    ).toBe(false);
  });

  it('rejects searchBatch over ten requests with a validation problem', async () => {
    const engine = createSearchEngine(deps);
    await expect(
      engine.searchBatch(
        Array.from({ length: 11 }, () => request()),
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
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
