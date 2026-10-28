import { describe, expect, it } from 'vitest';
import {
  MultiSpaceSearchApiRequestSchema,
  SearchApiRequestSchema,
  SearchApiResponseSchema,
  SearchFilterApiSchema,
  SearchRequestSchema,
  toPipelineSearchRequest,
} from '../../src/index';

const spaceA = '65f1e5b2a1c9d4b7e8f01234';
const spaceB = '65f1e5b2a1c9d4b7e8f01235';
const tagId = '65f1e5b2a1c9d4b7e8f0aaaa';

function request() {
  return {
    knowledgeSpaceId: spaceA,
    query: 'How long does a refund take?',
    tokenBudget: 5_000,
  };
}

describe('S7 public API DTOs', () => {
  it('strictly rejects unknown request fields', () => {
    expect(
      SearchApiRequestSchema.safeParse({
        ...request(),
        rawMongoFilter: { $where: 'true' },
      }).success,
    ).toBe(false);
  });

  it('enforces tag type/operator/value combinations', () => {
    expect(
      SearchFilterApiSchema.safeParse({
        logic: 'AND',
        conditions: [{ tagId, tagType: 'number', operator: '$contains', value: '1' }],
      }).success,
    ).toBe(false);
    expect(
      SearchFilterApiSchema.safeParse({
        logic: 'AND',
        conditions: [{ tagId, tagType: 'string', operator: '$eq' }],
      }).success,
    ).toBe(false);
    expect(
      SearchFilterApiSchema.safeParse({
        logic: 'AND',
        conditions: [{ tagId, tagType: 'string', operator: '$regex', value: '(?=secret)' }],
      }).success,
    ).toBe(false);
    expect(
      SearchFilterApiSchema.safeParse({
        logic: 'AND',
        conditions: [{ tagId, tagType: 'array', operator: '$contains', value: ['a', 'b'] }],
      }).success,
    ).toBe(true);
  });

  it('rejects reversed date ranges and maps into the internal pipeline contract', () => {
    expect(
      SearchFilterApiSchema.safeParse({
        logic: 'AND',
        conditions: [],
        createdAt: {
          gte: '2026-02-01T00:00:00Z',
          lte: '2026-01-01T00:00:00Z',
        },
      }).success,
    ).toBe(false);
    const parsed = SearchApiRequestSchema.parse({
      ...request(),
      searchMode: 'semantic',
      filters: { logic: 'AND', conditions: [] },
    });
    const internal = toPipelineSearchRequest(parsed, {
      requestId: 'req-a',
      workspaceId: 'ws-a',
      memberId: 'mem-a',
      models: { embeddingModel: 'embedding-1536' },
      mode: 'semantic',
    });
    expect(internal.searchMode).toBe('embedding');
    expect(internal.maxTokens).toBe(5_000);
    expect(internal.workspaceId).toBe('ws-a');
    expect(SearchRequestSchema.parse(internal).requestId).toBe('req-a');
  });

  it('requires route mode and body mode to agree when both are present', () => {
    const parsed = SearchApiRequestSchema.parse({
      ...request(),
      searchMode: 'hybrid',
    });
    expect(() =>
      toPipelineSearchRequest(parsed, {
        requestId: 'req-mismatch',
        workspaceId: 'ws-a',
        memberId: 'mem-a',
        models: { embeddingModel: 'embedding' },
        mode: 'semantic',
      }),
    ).toThrowError();
  });

  it('deduplicates nothing implicitly but requires the base space in multi-space input', () => {
    expect(
      MultiSpaceSearchApiRequestSchema.safeParse({
        ...request(),
        knowledgeSpaceIds: [spaceB],
      }).success,
    ).toBe(false);
    const parsed = MultiSpaceSearchApiRequestSchema.parse({
      ...request(),
      searchMode: 'hybrid',
      knowledgeSpaceIds: [spaceA, spaceB],
    });
    expect(parsed.knowledgeSpaceIds).toEqual([spaceA, spaceB]);
  });

  it('keeps the approved optional degraded/rerankApplied response fields', () => {
    const response = SearchApiResponseSchema.parse({
      searchId: 'search_test',
      mode: 'hybrid',
      items: [],
      partial: false,
      durationMs: 5,
      degraded: ['rerank_failed'],
      rerankApplied: false,
    });
    expect(response.degraded).toEqual(['rerank_failed']);
  });
});
