import { z } from 'zod';
import { SearchModeSchema } from '../../enums/dataset';

/** 设计文档 11.0：searchBatch 每次不超过 10 条，逐条独立降级。 */
export const SEARCH_BATCH_LIMIT = 10;

export const ImageQuerySchema = z
  .object({
    key: z.string().max(512).optional(),
    url: z.string().url().max(2048).optional(),
    weight: z.number().min(0).max(1).optional(),
  })
  .refine((value) => Boolean(value.key) || Boolean(value.url), {
    message: 'key 与 url 至少提供一个',
  });
export type ImageQuery = z.infer<typeof ImageQuerySchema>;

export const ModelSelectionSchema = z.object({
  embeddingModel: z.string().min(1),
  llmModel: z.string().min(1).optional(),
  vlmModel: z.string().min(1).optional(),
  rerankModel: z.string().min(1).optional(),
});
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export const SearchWeightsSchema = z.object({
  embedding: z.number().min(0).max(1).default(0.5),
  rerank: z.number().min(0).max(1).default(0.5),
});
export type SearchWeights = z.infer<typeof SearchWeightsSchema>;

export const SearchBudgetsSchema = z.object({
  totalTimeoutMs: z.number().int().min(1000).max(30000).default(30000),
  recallTimeoutMs: z.number().int().min(500).max(5000).default(5000),
  rerankTimeoutMs: z.number().int().min(1000).max(10000).default(10000),
});
export type SearchBudgets = z.infer<typeof SearchBudgetsSchema>;

export const SearchVersionPolicySchema = z.object({
  mode: z.enum(['latest', 'pinned']).default('latest'),
  pinned: z.string().min(1).max(128).optional(),
});
export type SearchVersionPolicy = z.infer<typeof SearchVersionPolicySchema>;

export const SearchRequestSchema = z.object({
  requestId: z.string().min(1),
  teamId: z.string().min(1),
  tmbId: z.string().optional(),
  uid: z.string().optional(),
  datasetIds: z.array(z.string().min(1)).min(1),
  collectionIds: z.array(z.string().min(1)).optional(),
  tagIds: z.array(z.string().min(1)).optional(),
  collectionFilterMatch: z.string().max(2000).optional(),
  textQueries: z.array(z.string()).max(20).default([]),
  imageQueries: z.array(ImageQuerySchema).max(10).default([]),
  models: ModelSelectionSchema,
  searchMode: SearchModeSchema.default('embedding'),
  limit: z.number().int().min(1).max(50).default(10),
  maxTokens: z.number().int().positive().default(4000),
  similarity: z.number().min(0).max(1).default(0),
  weights: SearchWeightsSchema.optional(),
  budgets: SearchBudgetsSchema.optional(),
  versionPolicy: SearchVersionPolicySchema.optional(),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const DegradedInfoSchema = z.object({
  stage: z.string().min(1).max(64),
  reason: z.string().min(1).max(256),
});
export type DegradedInfo = z.infer<typeof DegradedInfoSchema>;

export const CitationScoreSchema = z.object({
  type: z.enum(['embedding', 'fullText', 'reRank', 'rrf']),
  value: z.number(),
  index: z.number().int().min(0),
});
export type CitationScore = z.infer<typeof CitationScoreSchema>;

export const CitationSchema = z.object({
  dataId: z.string().min(1),
  chunkIndex: z.number().int().min(0),
  datasetId: z.string().min(1),
  collectionId: z.string().min(1),
  collectionName: z.string().min(1),
  sourceName: z.string().min(1),
  sourceType: z.enum(['file', 'link', 'apiFile', 'externalFile', 'images', 'virtual']),
  quoteText: z.string(),
  imagePreviewUrls: z.array(z.string()).optional(),
  updateTime: z.string().min(1),
  scores: z.array(CitationScoreSchema),
});
export type Citation = z.infer<typeof CitationSchema>;

export const SearchStatsSchema = z.object({
  searchMode: z.string().min(1),
  usingReRank: z.boolean(),
  usingSimilarityFilter: z.boolean(),
  embeddingTokens: z.number().int().min(0),
  rerankInputTokens: z.number().int().min(0),
  degraded: z.array(DegradedInfoSchema),
  durationMs: z.number().int().min(0),
});
export type SearchStats = z.infer<typeof SearchStatsSchema>;

export const SearchResultSchema = z.object({
  citations: z.array(CitationSchema),
  stats: SearchStatsSchema,
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

/** indexVersion = <embeddingModelId>:<dimension>:<schemaVersion>（设计文档 11.0）。 */
export function buildIndexVersion(
  embeddingModelId: string,
  dimension: number,
  schemaVersion: string,
): string {
  return `${embeddingModelId}:${dimension}:${schemaVersion}`;
}
