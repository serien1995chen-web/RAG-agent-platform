import { SearchFilterApiSchema } from '@kb/contracts';
import { describe, expect, it } from 'vitest';
import {
  assertSafeTagRegex,
  compileSearchFilter,
  evaluateTagCondition,
  type FilterTagDefinition,
  type SourceFilterFacts,
} from '../../src/index';

const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const tagIds = {
  string: '65f1e5b2a1c9d4b7e8f00001',
  number: '65f1e5b2a1c9d4b7e8f00002',
  datetime: '65f1e5b2a1c9d4b7e8f00003',
  array: '65f1e5b2a1c9d4b7e8f00004',
  missing: '65f1e5b2a1c9d4b7e8f00005',
} as const;

const definitions: FilterTagDefinition[] = [
  { tagId: tagIds.string, knowledgeSpaceId: spaceId, tagType: 'string', status: 'active' },
  { tagId: tagIds.number, knowledgeSpaceId: spaceId, tagType: 'number', status: 'active' },
  { tagId: tagIds.datetime, knowledgeSpaceId: spaceId, tagType: 'datetime', status: 'active' },
  { tagId: tagIds.array, knowledgeSpaceId: spaceId, tagType: 'array', status: 'active' },
];

function facts(overrides: Partial<SourceFilterFacts> = {}): SourceFilterFacts {
  return {
    sourceId: '65f1e5b2a1c9d4b7e8f10001',
    knowledgeSpaceId: spaceId,
    directoryId: '65f1e5b2a1c9d4b7e8f20001',
    directoryPath: ['65f1e5b2a1c9d4b7e8f20000'],
    createdAt: new Date('2026-01-15T00:00:00Z'),
    tagValues: [
      { tagId: tagIds.string, valueKey: 'Support', value: 'Support' },
      { tagId: tagIds.number, valueKey: '5', value: 5 },
      { tagId: tagIds.datetime, valueKey: '1000', value: 1_000 },
      { tagId: tagIds.array, valueKey: 'a\\0b', value: ['a', 'b'] },
    ],
    ...overrides,
  };
}

describe('TEST-X-TAG-FILTER-TYPES S7 SearchFilter truth table', () => {
  it('implements string operators with ASCII-only case folding', () => {
    const source = facts();
    expect(
      evaluateTagCondition(
        { tagId: tagIds.string, tagType: 'string', operator: '$contains', value: 'upp' },
        source,
        new Map(definitions.map((entry) => [entry.tagId, entry])),
      ),
    ).toBe(true);
    expect(
      evaluateTagCondition(
        { tagId: tagIds.string, tagType: 'string', operator: '$startsWith', value: 'SU' },
        source,
        new Map(definitions.map((entry) => [entry.tagId, entry])),
      ),
    ).toBe(true);
    expect(
      evaluateTagCondition(
        { tagId: tagIds.string, tagType: 'string', operator: '$eq', value: 'support' },
        source,
        new Map(definitions.map((entry) => [entry.tagId, entry])),
      ),
    ).toBe(false);
  });

  it('implements number, datetime and array operators', () => {
    const map = new Map(definitions.map((entry) => [entry.tagId, entry]));
    expect(
      evaluateTagCondition(
        { tagId: tagIds.number, tagType: 'number', operator: '$gte', value: 5 },
        facts(),
        map,
      ),
    ).toBe(true);
    expect(
      evaluateTagCondition(
        { tagId: tagIds.datetime, tagType: 'datetime', operator: '$lt', value: 1_001 },
        facts(),
        map,
      ),
    ).toBe(true);
    expect(
      evaluateTagCondition(
        { tagId: tagIds.array, tagType: 'array', operator: '$contains', value: ['a'] },
        facts(),
        map,
      ),
    ).toBe(true);
    expect(
      evaluateTagCondition(
        { tagId: tagIds.array, tagType: 'array', operator: '$in', value: ['a', 'b', 'c'] },
        facts(),
        map,
      ),
    ).toBe(true);
  });

  it('treats missing definitions as false and unassigned negative operators as true', () => {
    const source = facts({ tagValues: [] });
    const map = new Map(definitions.map((entry) => [entry.tagId, entry]));
    expect(
      evaluateTagCondition(
        { tagId: tagIds.missing, tagType: 'string', operator: '$ne', value: 'x' },
        source,
        map,
      ),
    ).toBe(false);
    expect(
      evaluateTagCondition(
        { tagId: tagIds.string, tagType: 'string', operator: '$ne', value: 'x' },
        source,
        map,
      ),
    ).toBe(true);
    expect(
      evaluateTagCondition(
        { tagId: tagIds.array, tagType: 'array', operator: '$notIn', value: ['x'] },
        source,
        map,
      ),
    ).toBe(true);
  });

  it('combines source, directory subtree, createdAt and tag logic', () => {
    const filter = SearchFilterApiSchema.parse({
      logic: 'OR',
      sourceIds: ['65f1e5b2a1c9d4b7e8f10001'],
      directoryIds: ['65f1e5b2a1c9d4b7e8f20000'],
      createdAt: {
        gte: '2026-01-01T00:00:00Z',
        lte: '2026-02-01T00:00:00Z',
      },
      conditions: [
        {
          tagId: tagIds.string,
          tagType: 'string',
          operator: '$eq',
          value: 'missing',
        },
        {
          tagId: tagIds.number,
          tagType: 'number',
          operator: '$eq',
          value: 9,
        },
      ],
    });
    expect(compileSearchFilter(filter, [facts()], definitions).emptyMatch).toBe(true);
    const zeroSourceFilter = SearchFilterApiSchema.parse({
      sourceIds: [],
      conditions: [],
    });
    expect(compileSearchFilter(zeroSourceFilter, [facts()], definitions).allowedSourceIds).toEqual(
      [],
    );
  });

  it('rejects unsafe regex subsets and preserves missing-tag safety', () => {
    expect(() => assertSafeTagRegex('(?=a)')).toThrowError();
    expect(() => assertSafeTagRegex('(a+)+$')).toThrowError();
    expect(assertSafeTagRegex('^support$')).toBeInstanceOf(RegExp);
  });
});
