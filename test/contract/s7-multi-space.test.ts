import { describe, expect, it } from 'vitest';
import { MultiSpaceSearchApiRequestSchema } from '../../packages/contracts/src/index';
import { mergeMultiSpaceCitations } from '../../packages/search/src/index';

const base = '65f1e5b2a1c9d4b7e8f01234';

describe('TEST-SEARCH-007-BLOCK MultiSpace contract', () => {
  it('accepts one and twenty spaces and rejects zero, twenty-one and missing base', () => {
    const request = (ids: string[]) =>
      MultiSpaceSearchApiRequestSchema.safeParse({
        knowledgeSpaceId: base,
        knowledgeSpaceIds: ids,
        query: 'refund',
        tokenBudget: 5_000,
        searchMode: 'semantic',
      }).success;
    expect(request([base])).toBe(true);
    const twenty = [
      base,
      ...Array.from(
        { length: 19 },
        (_, index) => `${base.slice(0, -2)}${String(index + 41).padStart(2, '0')}`,
      ),
    ];
    expect(request(twenty)).toBe(true);
    expect(request([])).toBe(false);
    expect(request([...twenty, twenty[1]!])).toBe(false);
    expect(request(['65f1e5b2a1c9d4b7e8f01235'])).toBe(false);
  });

  it('keeps failed Space partial semantics separate from empty success', () => {
    const merged = mergeMultiSpaceCitations([
      { knowledgeSpaceId: base, candidates: [] },
      {
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01235',
        failure: {
          channel: 'fullText',
          kind: 'timeout',
          degradedCode: 'fulltext_recall_failed',
          status: 504,
        },
      },
    ]);
    expect(merged.failedSpaces).toHaveLength(1);
    expect(merged.partial).toBe(true);
  });
});
