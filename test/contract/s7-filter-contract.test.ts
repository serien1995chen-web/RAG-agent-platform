import { describe, expect, it } from 'vitest';
import { SearchFilterApiSchema } from '../../packages/contracts/src/index';
import { assertSafeTagRegex, compileSearchFilter } from '../../packages/search/src/index';

const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const sourceId = '65f1e5b2a1c9d4b7e8f10001';
const tagId = '65f1e5b2a1c9d4b7e8f00001';

describe('TEST-X-TAG-FILTER-TYPES contract and regex budget', () => {
  it('accepts complete typed operator matrices and rejects arbitrary filters', () => {
    const valid = [
      { tagType: 'string', operator: '$regex', value: '^refund$' },
      { tagType: 'number', operator: '$gte', value: 1 },
      { tagType: 'datetime', operator: '$lt', value: 1_000 },
      { tagType: 'array', operator: '$notIn', value: ['archived'] },
    ];
    for (const condition of valid) {
      expect(
        SearchFilterApiSchema.safeParse({
          logic: 'AND',
          conditions: [{ tagId, ...condition }],
        }).success,
      ).toBe(true);
    }
    expect(
      SearchFilterApiSchema.safeParse({
        logic: 'AND',
        conditions: [],
        $or: [{ tagId }],
      }).success,
    ).toBe(false);
  });

  it('rejects unsafe regex corpus before repository access', () => {
    for (const pattern of ['(a+)+$', '(?=a)', '(a)\\1', '(?<name>a)\\k<name>']) {
      expect(() => assertSafeTagRegex(pattern)).toThrowError();
    }
    const startedAt = performance.now();
    expect(assertSafeTagRegex('^support$').test('support')).toBe(true);
    expect(performance.now() - startedAt).toBeLessThanOrEqual(50);
  });

  it('treats missing definitions as non-matching and zero source filters as empty', () => {
    const filter = SearchFilterApiSchema.parse({
      logic: 'AND',
      conditions: [{ tagId, tagType: 'string', operator: '$ne', value: 'archived' }],
    });
    const ok = compileSearchFilter(
      filter,
      [
        {
          sourceId,
          knowledgeSpaceId: spaceId,
          directoryId: null,
          directoryPath: [],
          createdAt: new Date(),
          tagValues: [],
        },
      ],
      [],
    );
    expect(ok.allowedSourceIds).toEqual([]);
    const zero = compileSearchFilter(
      SearchFilterApiSchema.parse({ logic: 'AND', conditions: [], sourceIds: [] }),
      [
        {
          sourceId,
          knowledgeSpaceId: spaceId,
          directoryId: null,
          directoryPath: [],
          createdAt: new Date(),
          tagValues: [],
        },
      ],
      [],
    );
    expect(zero.allowedSourceIds).toEqual([]);
  });
});
