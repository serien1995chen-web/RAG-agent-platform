import { z } from 'zod';

/** 设计文档 6.4 / 6.5：同一镜像通过 APP_WORKER_MODE 切换角色。 */
export const WorkerModeSchema = z.enum(['all', 'http', 'worker']);
export type WorkerMode = z.infer<typeof WorkerModeSchema>;

export const VersionCheckPolicySchema = z.enum(['strict', 'degraded', 'offline']);
export type VersionCheckPolicy = z.infer<typeof VersionCheckPolicySchema>;

/** ADR-015：仅支持 pgvector + Mongo fulltext + S3 兼容对象存储。 */
export const ProviderSelectionSchema = z.object({
  vector: z.literal('pgvector'),
  fullText: z.literal('mongo'),
  objectStore: z.literal('s3'),
  modelProvider: z.string().min(1).max(64),
});

export const SystemConfigSchema = z.object({
  appWorkerMode: WorkerModeSchema,
  environment: z.enum(['development', 'test', 'production']),
  /** 仅开发/测试环境使用的固定主体；生产环境必须为 null（设计文档 9.2 identity 约束）。 */
  devIdentity: z
    .object({ teamId: z.string().min(1).max(128), tmbId: z.string().min(1).max(128) })
    .nullable(),
  instanceId: z.string().min(1).max(128),
  dependencyBaselineId: z.string().min(1).max(128),
  versionCheckPolicy: VersionCheckPolicySchema,
  allowRuntimeOverride: z.boolean(),
  providerSelection: ProviderSelectionSchema,
  mongoUri: z.string().min(1),
  redisUrl: z.string().min(1),
  pgUrl: z.string().min(1),
  s3: z.object({
    endpoint: z.string().url(),
    region: z.string().min(1).max(64),
    bucket: z.string().min(1).max(256),
    accessKeyRef: z.string().min(1).max(256),
    secretKeyRef: z.string().min(1).max(256),
  }),
  otel: z.object({
    exporterEndpointRef: z.string().max(512).optional(),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']),
  }),
  timeouts: z.object({
    connectMs: z.number().int().positive(),
    requestMs: z.number().int().positive(),
  }),
});

export type SystemConfig = z.infer<typeof SystemConfigSchema>;
