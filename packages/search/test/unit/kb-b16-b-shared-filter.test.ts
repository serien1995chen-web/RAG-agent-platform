import { describe, expect, it } from 'vitest';
import { SearchFilterApiSchema } from '@kb/contracts';
import {
  compileSearchFilter,
  type FilterTagDefinition,
  type SourceFilterFacts,
} from '../../src/index';

const spaceId = '65f1e5b2a1c9d4b7e8f09100';
const tagIds = {
  string: '65f1e5b2a1c9d4b7e8f09101',
  number: '65f1e5b2a1c9d4b7e8f09102',
  datetime: '65f1e5b2a1c9d4b7e8f09103',
  array: '65f1e5b2a1c9d4b7e8f09104',
} as const;

const definitions: FilterTagDefinition[] = [
  { tagId: tagIds.string, knowledgeSpaceId: spaceId, tagType: 'string', status: 'active' },
  { tagId: tagIds.number, knowledgeSpaceId: spaceId, tagType: 'number', status: 'active' },
  { tagId: tagIds.datetime, knowledgeSpaceId: spaceId, tagType: 'datetime', status: 'active' },
  { tagId: tagIds.array, knowledgeSpaceId: spaceId, tagType: 'array', status: 'active' },
];

function facts(overrides: Partial<SourceFilterFacts> = {}): SourceFilterFacts {
  return {
    sourceId: '65f1e5b2a1c9d4b7e8f09201',
    knowledgeSpaceId: spaceId,
    directoryId: '65f1e5b2a1c9d4b7e8f09302',
    directoryPath: ['65f1e5b2a1c9d4b7e8f09301'],
    createdAt: new Date('2026-01-10T00:00:00.000Z'),
    tagValues: [
      { tagId: tagIds.string, valueKey: 'support', value: 'Support' },
      { tagId: tagIds.number, valueKey: '5', value: 5 },
      { tagId: tagIds.datetime, valueKey: '1000', value: 1_000 },
      { tagId: tagIds.array, valueKey: 'a,b', value: ['a', 'b'] },
    ],
    ...overrides,
  };
}

describe('TEST-X-TAG-FILTER-TYPES B16 B subcases', () => {
  it('keeps all four tag domains and AND/OR evaluation inside the authorized fact set', () => {
    const filter = SearchFilterApiSchema.parse({
      logic: 'AND',
      sourceIds: [facts().sourceId],
      directoryIds: ['65f1e5b2a1c9d4b7e8f09301'],
      createdAt: {
        gte: '2026-01-01T00:00:00.000Z',
        lte: '2026-02-01T00:00:00.000Z',
      },
      conditions: [
        { tagId: tagIds.string, tagType: 'string', operator: '$contains', value: 'upp' },
        { tagId: tagIds.number, tagType: 'number', operator: '$gte', value: 5 },
        { tagId: tagIds.datetime, tagType: 'datetime', operator: '$eq', value: 1_000 },
        { tagId: tagIds.array, tagType: 'array', operator: '$contains', value: ['a', 'b'] },
      ],
    });

    const compiled = compileSearchFilter(filter, [facts()], definitions, {
      requestId: 'req-b16-b-filter',
      traceId: 'trace-b16-b-filter',
    });

    expect(compiled.allowedSourceIds).toEqual([facts().sourceId]);
    expect(compiled.emptyMatch).toBe(false);
    expect(compiled.summary.conditionCount).toBe(4);
  });

  it('cannot widen the result set when the authorized fact list is empty', () => {
    const filter = SearchFilterApiSchema.parse({
      logic: 'OR',
      conditions: [
        { tagId: tagIds.string, tagType: 'string', operator: '$empty' },
        { tagId: tagIds.number, tagType: 'number', operator: '$notEmpty' },
      ],
    });

    expect(compileSearchFilter(filter, [], definitions).emptyMatch).toBe(true);
  });
});
