import { z } from 'zod';

/**
 * 设计文档 6.8：容量档案全部由部署注入，代码中不写产品承诺或统一容量默认值。
 */
export const PlatformCapacityProfileSchema = z.object({
  mongoPoolSize: z.number().int().positive(),
  redisConnections: z.number().int().positive(),
  pgPoolSize: z.number().int().positive(),
  s3Concurrency: z.number().int().positive(),
  providerConcurrency: z.number().int().positive(),
  batchSize: z.number().int().positive(),
  queueConcurrency: z.number().int().positive(),
  providerTimeoutMs: z.number().int().positive(),
  providerMaxRetries: z.number().int().min(0).max(10),
});

export type PlatformCapacityProfile = z.infer<typeof PlatformCapacityProfileSchema>;
