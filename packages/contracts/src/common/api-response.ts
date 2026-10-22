import { z } from 'zod';

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
