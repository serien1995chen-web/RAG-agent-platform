import { z } from 'zod';

/** Transitional types for source files scheduled for deletion in the hard cut. */
export const RetryabilitySchema = z.enum(['retryable', 'no-retry', 'manual']);
export type Retryability = z.infer<typeof RetryabilitySchema>;
export const SeveritySchema = z.enum(['warning', 'error', 'fatal']);
export type Severity = z.infer<typeof SeveritySchema>;
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

export interface LegacyApiResponse<T> {
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
}

export const KnowledgeErrorCodeSchema = z.string().regex(/^KNOWLEDGE_[A-Z0-9_]+$/);
export type KnowledgeErrorCode = z.infer<typeof KnowledgeErrorCodeSchema>;

export const KnowledgeErrorBodySchema = z.object({
  code: KnowledgeErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()),
});
export type KnowledgeErrorBody = z.infer<typeof KnowledgeErrorBodySchema>;

export const KnowledgeProblemSchema = z.object({
  success: z.literal(false),
  error: KnowledgeErrorBodySchema,
  traceId: z.string().min(1),
  requestId: z.string().min(1),
});
export type KnowledgeProblem = z.infer<typeof KnowledgeProblemSchema>;

export function knowledgeSuccessSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    success: z.literal(true),
    data: dataSchema,
    traceId: z.string().min(1),
    requestId: z.string().min(1),
  });
}

export interface KnowledgeSuccess<T> {
  success: true;
  data: T;
  traceId: string;
  requestId: string;
}

export type KnowledgeResponse<T> = KnowledgeSuccess<T> | KnowledgeProblem;
export type ApiResponse<T> = KnowledgeResponse<T>;

export const CursorPaginationSchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  sort: z.string().max(80).optional(),
});
export type CursorPagination = z.infer<typeof CursorPaginationSchema>;

export const HealthCheckSchema = z.object({
  name: z.enum(['mongo', 'redis', 'postgres', 's3', 'iam', 'telemetry']),
  status: z.enum(['ok', 'degraded', 'down', 'noop']),
  latencyMs: z.number().int().min(0),
});

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  checks: z.array(HealthCheckSchema),
  timestamp: z.string().datetime({ offset: true }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
