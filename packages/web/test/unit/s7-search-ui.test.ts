import { SearchApiRequestSchema } from '@kb/contracts';
import { describe, expect, it } from 'vitest';
import {
  S7_SEARCH_MODES,
  S7SearchFormSchema,
  S7_TAG_OPERATORS,
  buildS7SearchRequest,
  defaultS7SearchForm,
} from '../../src/forms/s7-search-form';
import {
  classifyS7SearchState,
  safeDegradedCode,
  similarityControlEnabled,
} from '../../src/components/s7-search-state';
import { S7DownstreamKnowledgeError } from '../../src/client/s7-downstream-knowledge-client';

const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const otherSpaceId = '65f1e5b2a1c9d4b7e8f01235';

function result(overrides: Record<string, unknown> = {}) {
  return {
    searchId: 'search_test',
    mode: 'hybrid' as const,
    items: [],
    partial: false,
    durationMs: 10,
    degraded: [],
    rerankApplied: false,
    ...overrides,
  };
}

describe('S7 Search UI state and form', () => {
  it('exposes only S7 modes and frozen tag operators', () => {
    expect(S7_SEARCH_MODES).toEqual(['semantic', 'fulltext', 'hybrid', 'multi_space']);
    expect(S7_TAG_OPERATORS.string).not.toContain('$like');
    expect(S7_TAG_OPERATORS.array).toEqual([
      '$is',
      '$isNot',
      '$contains',
      '$notContains',
      '$in',
      '$notIn',
      '$empty',
      '$notEmpty',
    ]);
  });

  it('validates mode, budget, weights and multi-space base membership', () => {
    const base = defaultS7SearchForm(spaceId);
    expect(S7SearchFormSchema.safeParse({ ...base, mode: 'deep' }).success).toBe(false);
    expect(S7SearchFormSchema.safeParse({ ...base, tokenBudget: 0 }).success).toBe(false);
    expect(S7SearchFormSchema.safeParse({ ...base, rerankWeight: 1.1 }).success).toBe(false);
    const multi = S7SearchFormSchema.parse({
      ...base,
      query: 'refund',
      mode: 'multi_space',
      knowledgeSpaceId: spaceId,
      knowledgeSpaceIds: [otherSpaceId],
    });
    const request = buildS7SearchRequest(multi);
    expect('knowledgeSpaceIds' in request ? request.knowledgeSpaceIds : []).toContain(spaceId);
  });

  it('maps API mode to the route request and keeps the public request strict', () => {
    const form = S7SearchFormSchema.parse({
      ...defaultS7SearchForm(spaceId),
      query: 'refund',
      mode: 'semantic',
    });
    const request = buildS7SearchRequest(form);
    expect(SearchApiRequestSchema.parse(request)).toMatchObject({
      searchMode: 'semantic',
      tokenBudget: 5_000,
    });
  });

  it('keeps empty, partial, degraded and Problem states distinct', () => {
    expect(classifyS7SearchState({ result: result() }).kind).toBe('empty');
    expect(
      classifyS7SearchState({
        result: result({ partial: true, degraded: ['fulltext_recall_failed'] }),
      }).kind,
    ).toBe('partial');
    expect(
      classifyS7SearchState({
        result: result({ items: [{}], degraded: ['rerank_failed'] }),
      }).kind,
    ).toBe('degraded');
    expect(
      classifyS7SearchState({
        error: new S7DownstreamKnowledgeError(403, {
          success: false,
          error: {
            code: 'KNOWLEDGE_FORBIDDEN',
            message: 'forbidden',
            retryable: false,
            details: {},
          },
          traceId: 'trace',
          requestId: 'request',
        }),
      }).kind,
    ).toBe('permission');
  });

  it('enables similarity only for semantic or rerank paths and filters unsafe codes', () => {
    expect(similarityControlEnabled('semantic', false)).toBe(true);
    expect(similarityControlEnabled('hybrid', false)).toBe(false);
    expect(similarityControlEnabled('hybrid', true)).toBe(true);
    expect(safeDegradedCode('vector_recall_failed')).toBe('vector_recall_failed');
    expect(safeDegradedCode('provider stack trace')).toBeNull();
    expect(safeDegradedCode(`space_${spaceId}_failed`)).toBe(`space_${spaceId}_failed`);
  });
});
