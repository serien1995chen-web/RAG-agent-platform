import type { SearchApiResponse } from '@kb/contracts';
import { describe, expect, it } from 'vitest';
import {
  classifyS7SearchState,
  safeDegradedCode,
  similarityControlEnabled,
} from '../../src/components/s7-search-state';
import {
  S7SearchFormSchema,
  buildS7SearchRequest,
  defaultS7SearchForm,
} from '../../src/forms/s7-search-form';

const spaceId = '65f1e5b2a1c9d4b7e8f01234';

function response(overrides: Partial<SearchApiResponse> = {}): SearchApiResponse {
  return {
    searchId: 'search_kb_b16_a',
    mode: 'semantic',
    items: [],
    partial: false,
    durationMs: 42,
    degraded: [],
    rerankApplied: false,
    ...overrides,
  };
}

describe('B16 codexA Search UI state', () => {
  it('L1-B16-A-SEARCH-001-UI01 requires non-blank input and preserves semantic parameters', () => {
    const base = defaultS7SearchForm(spaceId);
    expect(S7SearchFormSchema.safeParse(base).success).toBe(false);
    const parsed = S7SearchFormSchema.parse({
      ...base,
      query: '退款需要多久？',
      mode: 'semantic',
      similarity: 0.35,
    });
    expect(buildS7SearchRequest(parsed)).toMatchObject({
      searchMode: 'semantic',
      query: '退款需要多久？',
      similarity: 0.35,
    });
  });

  it('L1-B16-A-SEARCH-002-UI01 distinguishes empty, partial and degraded and filters unsafe codes', () => {
    expect(classifyS7SearchState({ result: response() }).kind).toBe('empty');
    expect(
      classifyS7SearchState({
        result: response({ partial: true, degraded: ['fulltext_recall_failed'] }),
      }).kind,
    ).toBe('partial');
    expect(classifyS7SearchState({ result: response({ degraded: ['rerank_failed'] }) }).kind).toBe(
      'degraded',
    );
    expect(safeDegradedCode('fulltext_recall_failed')).toBe('fulltext_recall_failed');
    expect(safeDegradedCode('provider body contains sk-secret')).toBeNull();
  });

  it('L1-B16-A-SEARCH-004-UI01 exposes rerank state and only enables similarity where applicable', () => {
    const reranked = response({
      items: [
        {
          segment: {
            id: '65f1e5b2a1c9d4b7e8f20001',
            workspaceId: 'ws-kb-b16-a',
            knowledgeSpaceId: spaceId,
            sourceId: '65f1e5b2a1c9d4b7e8f10001',
            searchEnabled: true,
            order: 0,
            question: '退款',
            answer: '五个工作日',
            content: '退款将在五个工作日内到账。',
            metadata: {},
            indexes: [],
            indexStatus: 'indexed',
            indexErrorCode: null,
            imageBlobRefId: null,
            version: 3,
          },
          score: 0.91,
          citation: {
            citationId: 'cit_kb_b16_a',
            segmentId: '65f1e5b2a1c9d4b7e8f20001',
            sourceId: '65f1e5b2a1c9d4b7e8f10001',
            knowledgeSpaceId: spaceId,
            title: '退款政策',
            sourceUrl: null,
            segmentRange: { start: 0, end: 12 },
            score: 0.91,
            version: 3,
            quoteText: '退款将在五个工作日内到账。',
            snapshotHash: 'c'.repeat(64),
            expiresAt: '2099-11-23T09:13:23.000Z',
          },
        },
      ],
      rerankApplied: true,
      durationMs: 137,
    });
    expect(classifyS7SearchState({ result: reranked })).toMatchObject({
      kind: 'ready',
      result: { durationMs: 137, rerankApplied: true },
    });
    expect(similarityControlEnabled('semantic', false)).toBe(true);
    expect(similarityControlEnabled('fulltext', false)).toBe(false);
    expect(similarityControlEnabled('hybrid', true)).toBe(true);
  });
});
