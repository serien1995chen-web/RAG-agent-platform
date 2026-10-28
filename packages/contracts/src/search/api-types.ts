import { z } from 'zod';
import { createKnowledgeError } from '../errors/knowledge-errors';
import type { ModelSelection, SearchRequest } from './types';

const SearchObjectIdSchema = z.string().regex(/^[a-f0-9]{24}$/);
const SEARCH_MODES = ['semantic', 'fulltext', 'hybrid'] as const;
const FILTER_LOGIC = ['AND', 'OR'] as const;

const STRING_OPERATORS = [
  '$eq',
  '$ne',
  '$contains',
  '$notContains',
  '$startsWith',
  '$endsWith',
  '$regex',
  '$empty',
  '$notEmpty',
] as const;
const NUMBER_OPERATORS = [
  '$eq',
  '$ne',
  '$gt',
  '$lt',
  '$gte',
  '$lte',
  '$empty',
  '$notEmpty',
] as const;
const DATETIME_OPERATORS = NUMBER_OPERATORS;
const ARRAY_OPERATORS = [
  '$is',
  '$isNot',
  '$contains',
  '$notContains',
  '$in',
  '$notIn',
  '$empty',
  '$notEmpty',
] as const;

function requiresValue(operator: string): boolean {
  return operator !== '$empty' && operator !== '$notEmpty';
}

export function isRe2CompatibleRegexSubset(pattern: string): boolean {
  const length = [...pattern].length;
  if (length < 1 || length > 64) return false;
  if (/\\[1-9]|\\k<|\\g<|\(\?P=|\(\?R|\(\?0|\(\?[=!<]|\(\?>/.test(pattern)) return false;
  if (/(?:\*|\+|\?|\{[^}]+\})\+/.test(pattern)) return false;
  try {
    new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}

export const TagStringFilterConditionSchema = z
  .object({
    tagId: SearchObjectIdSchema,
    tagType: z.literal('string'),
    operator: z.enum(STRING_OPERATORS),
    value: z.string().max(256).optional(),
  })
  .strict()
  .superRefine((condition, context) => {
    if (requiresValue(condition.operator) && condition.value === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'value is required for this operator',
      });
    }
    if (condition.operator === '$regex' && condition.value !== undefined) {
      if (!isRe2CompatibleRegexSubset(condition.value)) {
        context.addIssue({
          code: 'custom',
          path: ['value'],
          message: 'regex must use a safe RE2-compatible subset',
        });
      }
    }
  });

export const TagNumberFilterConditionSchema = z
  .object({
    tagId: SearchObjectIdSchema,
    tagType: z.literal('number'),
    operator: z.enum(NUMBER_OPERATORS),
    value: z.number().finite().optional(),
  })
  .strict()
  .superRefine((condition, context) => {
    if (requiresValue(condition.operator) && condition.value === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'value is required for this operator',
      });
    }
  });

export const TagDatetimeFilterConditionSchema = z
  .object({
    tagId: SearchObjectIdSchema,
    tagType: z.literal('datetime'),
    operator: z.enum(DATETIME_OPERATORS),
    value: z.number().int().safe().optional(),
  })
  .strict()
  .superRefine((condition, context) => {
    if (requiresValue(condition.operator) && condition.value === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'value is required for this operator',
      });
    }
  });

export const TagArrayFilterConditionSchema = z
  .object({
    tagId: SearchObjectIdSchema,
    tagType: z.literal('array'),
    operator: z.enum(ARRAY_OPERATORS),
    value: z.union([z.string(), z.array(z.string()).min(1).max(100)]).optional(),
  })
  .strict()
  .superRefine((condition, context) => {
    if (requiresValue(condition.operator) && condition.value === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'value is required for this operator',
      });
    }
  });

export const TagFilterConditionSchema = z.union([
  TagStringFilterConditionSchema,
  TagNumberFilterConditionSchema,
  TagDatetimeFilterConditionSchema,
  TagArrayFilterConditionSchema,
]);

const SearchCreatedAtSchema = z
  .object({
    gte: z.string().datetime({ offset: true }).optional(),
    lte: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((range, context) => {
    if (range.gte && range.lte && Date.parse(range.gte) > Date.parse(range.lte)) {
      context.addIssue({
        code: 'custom',
        path: ['gte'],
        message: 'gte must not be later than lte',
      });
    }
  });

export const SearchFilterApiSchema = z
  .object({
    logic: z.enum(FILTER_LOGIC).default('AND'),
    conditions: z.array(TagFilterConditionSchema).max(64).default([]),
    createdAt: SearchCreatedAtSchema.optional(),
    sourceIds: z.array(SearchObjectIdSchema).max(200).optional(),
    directoryIds: z.array(SearchObjectIdSchema).max(200).optional(),
  })
  .strict();

const SearchRequestObject = z.object({
  knowledgeSpaceId: SearchObjectIdSchema,
  query: z
    .string()
    .min(1)
    .max(20_000)
    .refine((value) => value.trim().length > 0, 'query must not be blank'),
  tokenBudget: z.number().int().min(1).max(20_000),
  similarity: z.number().min(0).max(1).default(0.2),
  searchMode: z.enum(SEARCH_MODES).optional(),
  embeddingWeight: z.number().min(0).max(1).default(0.5),
  usingRerank: z.boolean().default(false),
  rerankWeight: z.number().min(0).max(1).default(0.5),
  filters: SearchFilterApiSchema.optional(),
});

export const SearchApiRequestSchema = SearchRequestObject.strict();
export const MultiSpaceSearchApiRequestSchema = SearchRequestObject.extend({
  knowledgeSpaceIds: z.array(SearchObjectIdSchema).min(1).max(20),
})
  .strict()
  .superRefine((request, context) => {
    if (!request.knowledgeSpaceIds.includes(request.knowledgeSpaceId)) {
      context.addIssue({
        code: 'custom',
        path: ['knowledgeSpaceIds'],
        message: 'knowledgeSpaceIds must include knowledgeSpaceId',
      });
    }
  });

export const ImageSearchApiRequestSchema = SearchRequestObject.extend({
  imageUploadIds: z.array(z.string().min(1).max(64)).min(1).max(10),
}).strict();

const DeepStopReasonSchema = z.enum([
  'sufficient',
  'round_limit',
  'token_budget',
  'no_new_evidence',
  'dependency_failure',
]);

export const DeepSearchApiRequestSchema = SearchRequestObject.extend({
  knowledgeSpaceIds: z.array(SearchObjectIdSchema).min(1).max(20),
  maxRounds: z.number().int().min(1).max(3).default(3),
  roundTokenBudget: z.number().int().min(500).max(20_000).default(5_000),
  stopWhenNoNewEvidence: z.boolean().default(true),
})
  .strict()
  .superRefine((request, context) => {
    if (!request.knowledgeSpaceIds.includes(request.knowledgeSpaceId)) {
      context.addIssue({
        code: 'custom',
        path: ['knowledgeSpaceIds'],
        message: 'knowledgeSpaceIds must include knowledgeSpaceId',
      });
    }
  });

export const SegmentIndexApiSchema = z
  .object({
    indexId: z.string().min(1),
    type: z.enum(['default', 'custom', 'question', 'summary', 'image', 'image_caption']),
    modelId: z.string().min(1),
    dimension: z.union([z.literal(768), z.literal(1024), z.literal(1536), z.literal(3072)]),
    storageType: z.enum(['vector', 'halfvec']),
    vectorProfile: z.enum([
      'knowledge_segment_vectors_768',
      'knowledge_segment_vectors_1024',
      'knowledge_segment_vectors_1536',
      'knowledge_segment_vectors_3072',
    ]),
    vectorId: z.string().uuid(),
    text: z.string(),
    version: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((index, context) => {
    const expectedStorage = index.dimension === 3072 ? 'halfvec' : 'vector';
    if (index.storageType !== expectedStorage) {
      context.addIssue({
        code: 'custom',
        path: ['storageType'],
        message: `storageType must be ${expectedStorage} for dimension ${index.dimension}`,
      });
    }
    if (!index.vectorProfile.endsWith(String(index.dimension))) {
      context.addIssue({
        code: 'custom',
        path: ['vectorProfile'],
        message: 'vectorProfile must match dimension',
      });
    }
  });

export const SearchSegmentApiSchema = z
  .object({
    id: SearchObjectIdSchema,
    workspaceId: z.string().min(1).max(64),
    knowledgeSpaceId: SearchObjectIdSchema,
    sourceId: SearchObjectIdSchema,
    searchEnabled: z.boolean(),
    order: z.number().int().nonnegative(),
    question: z.string(),
    answer: z.string(),
    content: z.string(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    indexes: z.array(SegmentIndexApiSchema).default([]),
    indexStatus: z.enum([
      'pending',
      'indexing',
      'indexed',
      'error',
      'rebuilding',
      'rebuild_failed',
    ]),
    indexErrorCode: z.string().nullable().optional(),
    imageBlobRefId: SearchObjectIdSchema.nullable().optional(),
    version: z.number().int().nonnegative(),
  })
  .strict();

const CitationSourceUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'sourceUrl must use http or https');

export const CitationApiSchema = z
  .object({
    citationId: z.string().min(1),
    segmentId: SearchObjectIdSchema,
    sourceId: SearchObjectIdSchema,
    title: z.string().min(1),
    sourceUrl: CitationSourceUrlSchema.nullable(),
    segmentRange: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
      })
      .strict()
      .refine((range) => range.end >= range.start, 'segmentRange.end must be >= start'),
    score: z.number().finite(),
    version: z.number().int().nonnegative(),
  })
  .strict();

export const SearchApiItemSchema = z
  .object({
    segment: SearchSegmentApiSchema,
    score: z.number().finite(),
    citation: CitationApiSchema,
  })
  .strict();

export const SearchApiResponseSchema = z
  .object({
    searchId: z.string().startsWith('search_'),
    mode: z.enum(['semantic', 'fulltext', 'hybrid', 'image', 'multi_space']),
    items: z.array(SearchApiItemSchema).max(50),
    partial: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    degraded: z.array(z.string().min(1).max(64)).max(64).optional(),
    rerankApplied: z.boolean().optional(),
  })
  .strict();

export const DeepSearchRoundSchema = z
  .object({
    round: z.number().int().min(1).max(3),
    queries: z.array(z.string().min(1)).min(1).max(5),
    candidateCount: z.number().int().min(0),
    sufficient: z.boolean(),
  })
  .strict();

export const DeepSearchApiResponseSchema = SearchApiResponseSchema.extend({
  mode: z.literal('multi_space'),
  rounds: z.array(DeepSearchRoundSchema).min(1).max(3),
  stopReason: DeepStopReasonSchema,
  usage: z
    .object({
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
    })
    .strict(),
}).strict();

export const DeepPlannerOutputSchema = z
  .object({
    queries: z
      .array(z.string().refine((value) => value.trim().length > 0, 'query must not be blank'))
      .min(1)
      .max(5),
    sufficient: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.queries.reduce((total, query) => total + [...query].length, 0) > 20_000) {
      context.addIssue({
        code: 'custom',
        path: ['queries'],
        message: 'total query length must be <= 20000 code points',
      });
    }
  });

export type SearchApiMode = (typeof SEARCH_MODES)[number];
export type SearchFilterApi = z.infer<typeof SearchFilterApiSchema>;
export type TagFilterCondition = z.infer<typeof TagFilterConditionSchema>;
export type SearchApiRequest = z.infer<typeof SearchApiRequestSchema>;
export type MultiSpaceSearchApiRequest = z.infer<typeof MultiSpaceSearchApiRequestSchema>;
export type ImageSearchApiRequest = z.infer<typeof ImageSearchApiRequestSchema>;
export type DeepSearchApiRequest = z.infer<typeof DeepSearchApiRequestSchema>;
export type DeepSearchRound = z.infer<typeof DeepSearchRoundSchema>;
export type DeepPlannerOutput = z.infer<typeof DeepPlannerOutputSchema>;
export type SearchApiResponse = z.infer<typeof SearchApiResponseSchema>;
export type DeepSearchApiResponse = z.infer<typeof DeepSearchApiResponseSchema>;
export type SearchApiItem = z.infer<typeof SearchApiItemSchema>;
export type CitationApi = z.infer<typeof CitationApiSchema>;
export type SearchSegmentApi = z.infer<typeof SearchSegmentApiSchema>;

const INTERNAL_MODE = {
  semantic: 'embedding',
  fulltext: 'fullTextRecall',
  hybrid: 'mixedRecall',
} as const;

export interface PipelineSearchContext {
  requestId: string;
  workspaceId: string;
  memberId: string;
  models: ModelSelection;
  mode?: SearchApiMode;
  limit?: number;
  knowledgeSpaceIds?: readonly string[];
  indexVersion?: string;
}

export function toPipelineSearchRequest(
  request: SearchApiRequest | MultiSpaceSearchApiRequest,
  context: PipelineSearchContext,
): SearchRequest {
  const mode = context.mode ?? request.searchMode ?? 'hybrid';
  if (request.searchMode !== undefined && request.searchMode !== mode) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.requestId,
      details: {
        field: 'searchMode',
        expected: mode,
        actual: request.searchMode,
      },
    });
  }
  const knowledgeSpaceIds =
    context.knowledgeSpaceIds && context.knowledgeSpaceIds.length > 0
      ? [...context.knowledgeSpaceIds]
      : [request.knowledgeSpaceId];
  return {
    requestId: context.requestId,
    workspaceId: context.workspaceId,
    memberId: context.memberId,
    knowledgeSpaceIds,
    ...(request.filters?.sourceIds ? { sourceIds: request.filters.sourceIds } : {}),
    textQueries: [request.query],
    imageQueries: [],
    models: context.models,
    ...(context.indexVersion ? { indexVersion: context.indexVersion } : {}),
    searchMode: INTERNAL_MODE[mode],
    limit: context.limit ?? 10,
    maxTokens: request.tokenBudget,
    similarity: request.similarity,
    weights: {
      embedding: request.embeddingWeight,
      rerank: request.rerankWeight,
    },
  };
}

export function withPipelineImageQueries(
  request: SearchRequest,
  imageQueries: NonNullable<SearchRequest['imageQueries']>,
): SearchRequest {
  if (imageQueries.length < 1 || imageQueries.length > 10) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: request.requestId,
      traceId: request.requestId,
      details: { field: 'imageQueries', min: 1, max: 10 },
    });
  }
  return { ...request, imageQueries };
}

export function citationRangeSchema() {
  return z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .strict()
    .refine((range) => range.end >= range.start, 'segmentRange.end must be >= start');
}
