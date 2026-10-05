import { z } from 'zod';

export const ErrorFamilySchema = z.enum([
  'auth',
  'permission',
  'validation',
  'conflict',
  'limit',
  'storage',
  'provider',
  'task',
  'migration',
  'extension',
  'internal',
]);
export type ErrorFamily = z.infer<typeof ErrorFamilySchema>;

export const RetryabilitySchema = z.enum(['retryable', 'no-retry', 'manual']);
export type Retryability = z.infer<typeof RetryabilitySchema>;

export const SeveritySchema = z.enum(['warning', 'error', 'fatal']);
export type Severity = z.infer<typeof SeveritySchema>;

/** 设计文档 12.3：字段冻结，旧字段不得删除。 */
export const ApiErrorSchema = z.object({
  code: z.number().int().positive(),
  statusText: z.string().min(1),
  messageKey: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  message: z.string(),
  errorType: ErrorFamilySchema,
  retryable: RetryabilitySchema,
  severity: SeveritySchema,
  requestId: z.string().min(1),
  zodError: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export type ApiResponse<T> = {
  code: number;
  statusText: string;
  message: string;
  messageKey: string;
  params: Record<string, unknown>;
  data: T | null;
  errorType: ErrorFamily | null;
  retryable: Retryability | null;
  severity: Severity | null;
  requestId: string;
  zodError?: unknown;
};

export function apiResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    code: z.number().int(),
    statusText: z.string(),
    message: z.string(),
    messageKey: z.string(),
    params: z.record(z.string(), z.unknown()),
    data: dataSchema.nullable(),
    errorType: ErrorFamilySchema.nullable(),
    retryable: RetryabilitySchema.nullable(),
    severity: SeveritySchema.nullable(),
    requestId: z.string(),
    zodError: z.unknown().optional(),
  });
}

/** 分页规则（设计文档 12.8.1）：page 与 cursor 互斥，limit 1-100。 */
export const PaginationSchema = z.object({
  page: z.number().int().min(1).default(1),
  cursor: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  sortBy: z.enum(['updateTime', 'createTime', 'name']).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export const HealthCheckSchema = z.object({
  name: z.string().min(1).max(64),
  status: z.enum(['ok', 'degraded', 'failed']),
  durationMs: z.number().int().min(0),
});

/** 健康探针响应（设计文档 6.9 / 12.9）：不暴露版本、密钥、连接串与租户信息。 */
export const HealthResponseSchema = z.object({
  status: z.string().min(1),
  checks: z.array(HealthCheckSchema),
  durationMs: z.number().int().min(0),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const NoRequestBodySchema = z.object({});
