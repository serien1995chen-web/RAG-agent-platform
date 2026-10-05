import { z } from 'zod';
import { DEFAULT_CHUNK_POLICY } from '@kb/chunk';

const ChunkPolicyDefaultsSchema = z.object({
  mode: z.enum(['auto', 'paragraph', 'custom']),
  chunkSize: z.number().int().min(64).max(8000),
  minSize: z.number().int().min(1).max(4000),
  maxSize: z.number().int().min(500).max(8000),
  overlapRatio: z.number().min(0).max(0.9),
  paragraphDeep: z.number().int().min(1).max(5),
  customRegs: z.array(z.string().max(200)).max(5),
  lengthUnit: z.enum(['char', 'token']),
  forceSplit: z.boolean(),
  maxChunks: z.number().int().min(1).max(50000),
});

/** 设计文档 6.6 / 12.6：业务上限、超时、TTL、batch、并发、权重由配置注入。 */
export const DatasetRuntimeConfigSchema = z.object({
  eventPublishTimeoutMs: z.number().int().min(100).max(30000),
  queueWaitTimeoutMs: z.number().int().positive(),
  trainingTtlDays: z.number().int().positive(),
  imageTtlDays: z.number().int().positive(),
  maxPushItems: z.number().int().min(1).max(10000),
  maxRequestBodyBytes: z.number().int().positive(),
  maxRawTextBytes: z.number().int().positive(),
  maxImagesPerRequest: z.number().int().min(1).max(100),
  search: z.object({
    defaultLimit: z.number().int().min(1).max(50),
    maxLimit: z.number().int().min(1).max(50),
    maxTokens: z.number().int().positive(),
    defaultSimilarity: z.number().min(0).max(1),
    defaultWeights: z.object({
      embedding: z.number().min(0).max(1),
      rerank: z.number().min(0).max(1),
    }),
  }),
  chunkDefaults: ChunkPolicyDefaultsSchema,
});

export type DatasetRuntimeConfig = z.infer<typeof DatasetRuntimeConfigSchema>;

export const DEFAULT_DATASET_RUNTIME_CONFIG: DatasetRuntimeConfig = {
  eventPublishTimeoutMs: 2000,
  queueWaitTimeoutMs: 30 * 60 * 1000,
  trainingTtlDays: 7,
  imageTtlDays: 7,
  maxPushItems: 200,
  maxRequestBodyBytes: 10 * 1024 * 1024,
  maxRawTextBytes: 10 * 1024 * 1024,
  maxImagesPerRequest: 10,
  search: {
    defaultLimit: 10,
    maxLimit: 50,
    maxTokens: 4000,
    defaultSimilarity: 0,
    defaultWeights: { embedding: 0.5, rerank: 0.5 },
  },
  chunkDefaults: DEFAULT_CHUNK_POLICY,
};
