import {
  MultiSpaceSearchApiRequestSchema,
  SearchApiRequestSchema,
  SearchFilterApiSchema,
  type MultiSpaceSearchApiRequest,
  type SearchApiRequest,
  type SearchFilterApi,
  type TagFilterCondition,
} from '@kb/contracts';
import { z } from 'zod';

export const S7_SEARCH_MODES = ['semantic', 'fulltext', 'hybrid', 'multi_space'] as const;
export type S7SearchMode = (typeof S7_SEARCH_MODES)[number];

export const S7_TAG_TYPES = ['string', 'number', 'datetime', 'array'] as const;
export type S7TagType = (typeof S7_TAG_TYPES)[number];

export const S7_TAG_OPERATORS: Readonly<Record<S7TagType, readonly string[]>> = {
  string: [
    '$eq',
    '$ne',
    '$contains',
    '$notContains',
    '$startsWith',
    '$endsWith',
    '$regex',
    '$empty',
    '$notEmpty',
  ],
  number: ['$eq', '$ne', '$gt', '$lt', '$gte', '$lte', '$empty', '$notEmpty'],
  datetime: ['$eq', '$ne', '$gt', '$lt', '$gte', '$lte', '$empty', '$notEmpty'],
  array: ['$is', '$isNot', '$contains', '$notContains', '$in', '$notIn', '$empty', '$notEmpty'],
};

export const S7SearchFormSchema = z
  .object({
    knowledgeSpaceId: z.string().regex(/^[a-f0-9]{24}$/),
    knowledgeSpaceIds: z
      .array(z.string().regex(/^[a-f0-9]{24}$/))
      .max(20)
      .default([]),
    query: z.string().min(1).max(20_000),
    mode: z.enum(S7_SEARCH_MODES).default('hybrid'),
    tokenBudget: z.number().int().min(1).max(20_000).default(5_000),
    similarity: z.number().min(0).max(1).default(0.2),
    embeddingWeight: z.number().min(0).max(1).default(0.5),
    rerankWeight: z.number().min(0).max(1).default(0.5),
    usingRerank: z.boolean().default(false),
    filters: SearchFilterApiSchema.default({
      logic: 'AND',
      conditions: [],
    }),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'multi_space') {
      const ids = [...new Set([value.knowledgeSpaceId, ...value.knowledgeSpaceIds])];
      if (ids.length > 20) {
        context.addIssue({
          code: 'custom',
          path: ['knowledgeSpaceIds'],
          message: 'at most 20 knowledge spaces are allowed',
        });
      }
    }
  });

export type S7SearchFormValues = z.infer<typeof S7SearchFormSchema>;

export function defaultS7SearchForm(knowledgeSpaceId: string): S7SearchFormValues {
  return {
    knowledgeSpaceId,
    knowledgeSpaceIds: [knowledgeSpaceId],
    query: '',
    mode: 'hybrid',
    tokenBudget: 5_000,
    similarity: 0.2,
    embeddingWeight: 0.5,
    rerankWeight: 0.5,
    usingRerank: false,
    filters: { logic: 'AND', conditions: [] },
  };
}

function operatorAllowsValue(operator: string): boolean {
  return operator !== '$empty' && operator !== '$notEmpty';
}

function coerceTagValue(type: S7TagType, raw: unknown): string | number | string[] | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (type === 'number') {
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (type === 'datetime') {
    if (typeof raw === 'number') return raw;
    const parsed = Date.parse(String(raw));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (type === 'array') {
    if (Array.isArray(raw)) return raw.map(String);
    return String(raw)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return String(raw);
}

export function tagConditionFromDraft(input: {
  tagId: string;
  tagType: S7TagType;
  operator: string;
  value?: unknown;
}): TagFilterCondition {
  const common = {
    tagId: input.tagId,
    operator: input.operator as never,
    ...(operatorAllowsValue(input.operator)
      ? { value: coerceTagValue(input.tagType, input.value) }
      : {}),
  };
  if (input.tagType === 'string') {
    return { ...common, tagType: 'string' } as TagFilterCondition;
  }
  if (input.tagType === 'number') {
    return { ...common, tagType: 'number' } as TagFilterCondition;
  }
  if (input.tagType === 'datetime') {
    return { ...common, tagType: 'datetime' } as TagFilterCondition;
  }
  return { ...common, tagType: 'array' } as TagFilterCondition;
}

export function buildS7SearchFilters(input: {
  sourceIds?: string[];
  directoryIds?: string[];
  createdAtGte?: string;
  createdAtLte?: string;
  logic: 'AND' | 'OR';
  conditions: TagFilterCondition[];
}): SearchFilterApi {
  return SearchFilterApiSchema.parse({
    logic: input.logic,
    conditions: input.conditions,
    ...(input.sourceIds?.length ? { sourceIds: input.sourceIds } : {}),
    ...(input.directoryIds?.length ? { directoryIds: input.directoryIds } : {}),
    ...(input.createdAtGte || input.createdAtLte
      ? {
          createdAt: {
            ...(input.createdAtGte ? { gte: input.createdAtGte } : {}),
            ...(input.createdAtLte ? { lte: input.createdAtLte } : {}),
          },
        }
      : {}),
  });
}

export function buildS7SearchRequest(
  values: S7SearchFormValues,
): SearchApiRequest | MultiSpaceSearchApiRequest {
  const base = {
    knowledgeSpaceId: values.knowledgeSpaceId,
    query: values.query,
    tokenBudget: values.tokenBudget,
    similarity: values.similarity,
    embeddingWeight: values.embeddingWeight,
    usingRerank: values.usingRerank,
    rerankWeight: values.rerankWeight,
    filters: values.filters,
  };
  if (values.mode === 'multi_space') {
    return MultiSpaceSearchApiRequestSchema.parse({
      ...base,
      knowledgeSpaceIds: [...new Set([values.knowledgeSpaceId, ...values.knowledgeSpaceIds])],
    });
  }
  return SearchApiRequestSchema.parse({
    ...base,
    searchMode: values.mode,
  });
}

export function patchTagCondition(
  filter: SearchFilterApi,
  index: number,
  update: Partial<TagFilterCondition>,
): SearchFilterApi {
  return SearchFilterApiSchema.parse({
    ...filter,
    conditions: filter.conditions.map((condition, current) =>
      current === index ? { ...condition, ...update } : condition,
    ),
  });
}

export function addTagCondition(filter: SearchFilterApi): SearchFilterApi {
  return SearchFilterApiSchema.parse({
    ...filter,
    conditions: [
      ...filter.conditions,
      {
        tagId: '000000000000000000000000',
        tagType: 'string',
        operator: '$eq',
        value: '',
      },
    ],
  });
}
