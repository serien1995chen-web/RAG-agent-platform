import { describe, expect, it } from 'vitest';
import {
  SYNONYM_QUERY_MAX_CODE_POINTS,
  expandQuery,
  fallbackSynonymExpansion,
  mergeExpansions,
  type SynonymExpansionMapping,
} from '../../src/synonym-expansion';

function mapping(
  logicalMappingId: string,
  standard: string,
  synonyms: readonly string[],
): SynonymExpansionMapping {
  return {
    logicalMappingId,
    standardizedTerm: standard,
    normalizedStandardizedTerm: standard.toLowerCase(),
    synonymTerms: [...synonyms],
    normalizedSynonymTerms: synonyms.map((value) => value.toLowerCase()),
  };
}

describe('S9 synonym query expansion', () => {
  it('TEST-SEARCH-003-BLOCK preserves the original query and adds stable standards', () => {
    const result = expandQuery('退货政策', [mapping('000000000000000000000001', '退款', ['退货'])]);
    expect(result.originalQuery).toBe('退货政策');
    expect(result.expandedQuery).toBe('退货政策 退款');
    expect(result.hits).toHaveLength(1);
    expect(result.appliedMappingIds).toEqual(['000000000000000000000001']);
  });

  it('TEST-SEARCH-003-BLOCK protects standard terms and uses the longest synonym', () => {
    const mappings = [
      mapping('000000000000000000000002', 'short-standard', ['退款']),
      mapping('000000000000000000000001', 'long-standard', ['退款政策']),
    ];
    expect(expandQuery('退款政策', mappings)).toMatchObject({
      expandedQuery: '退款政策 long-standard',
      fallbackReason: null,
    });
    expect(
      expandQuery('退款', [mapping('000000000000000000000003', '退款', ['退款'])]),
    ).toMatchObject({
      expandedQuery: '退款',
      hits: [],
    });
  });

  it('TEST-SEARCH-003-BLOCK enforces ASCII word boundaries and preserves Unicode punctuation', () => {
    const result = expandQuery('concatenate cat, 内部 空白!', [
      mapping('000000000000000000000001', 'Feline', ['cat']),
      mapping('000000000000000000000002', 'Standard Term', ['内部 空白!']),
    ]);
    expect(result.hits.filter((hit) => hit.normalizedStandardizedTerm === 'feline')).toHaveLength(
      1,
    );
    expect(result.expandedQuery).toContain('内部 空白!');
    expect(result.expandedQuery).toContain('Standard Term');
  });

  it('TEST-SEARCH-003-BLOCK merges multiple spaces in request order without overwriting', () => {
    const [result] = mergeExpansions({
      queries: ['退款'],
      contexts: [
        {
          knowledgeSpaceId: 'space-a',
          fileVersion: 3,
          mappings: [mapping('000000000000000000000001', 'Apple', ['退款'])],
        },
        {
          knowledgeSpaceId: 'space-b',
          fileVersion: 9,
          mappings: [mapping('000000000000000000000002', 'Banana', ['退款'])],
        },
      ],
    });
    expect(result?.expandedQuery).toBe('退款 Apple Banana');
    expect(result?.hits.map((hit) => hit.knowledgeSpaceId)).toEqual(['space-a', 'space-b']);
    expect(result?.hits.map((hit) => hit.fileVersion)).toEqual([3, 9]);
  });

  it('TEST-SEARCH-003-BLOCK sorts same-space additions by normalized standard and mapping id', () => {
    const result = expandQuery('z a', [
      mapping('000000000000000000000002', 'Zulu', ['z']),
      mapping('000000000000000000000001', 'Alpha', ['a']),
    ]);
    expect(result.expandedQuery).toBe('z a Alpha Zulu');
    expect(result.normalizedStandardTerms).toEqual(['alpha', 'zulu']);
  });

  it('TEST-SEARCH-003-BLOCK falls back to the original query above 4096 code points', () => {
    const query = `${'x'.repeat(SYNONYM_QUERY_MAX_CODE_POINTS - 8)} alias`;
    const result = expandQuery(query, [mapping('000000000000000000000001', 'standard', ['alias'])]);
    expect(result.fallbackReason).toBe('code_point_limit');
    expect(result.expandedQuery).toBe(query);
    expect(result.appliedMappingIds).toEqual([]);
    expect(fallbackSynonymExpansion(query, 'version_changed')).toMatchObject({
      expandedQuery: query,
      fallbackReason: 'version_changed',
    });
  });
});
