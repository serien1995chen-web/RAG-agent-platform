import {
  KnowledgeProblemSchema,
  type KnowledgeErrorBody,
  type KnowledgeErrorCode,
  type KnowledgeProblem,
} from '../common/api-response';

export interface KnowledgeErrorDefinition {
  status: number;
  retryable: boolean;
  message: string;
}

export const KNOWLEDGE_ERROR_CATALOG = {
  KNOWLEDGE_AUTH_REQUIRED: {
    status: 401,
    retryable: false,
    message: 'A valid JWT or API Key is required.',
  },
  KNOWLEDGE_FORBIDDEN: {
    status: 403,
    retryable: false,
    message: 'The resource is not available in this workspace.',
  },
  KNOWLEDGE_NOT_FOUND: {
    status: 404,
    retryable: false,
    message: 'The resource was not found.',
  },
  KNOWLEDGE_VALIDATION_FAILED: {
    status: 400,
    retryable: false,
    message: 'Request validation failed.',
  },
  KNOWLEDGE_CONFLICT: {
    status: 409,
    retryable: false,
    message: 'The resource version or state conflicts with this request.',
  },
  KNOWLEDGE_REFERENCE_CONFLICT: {
    status: 409,
    retryable: false,
    message: 'The resource is still referenced.',
  },
  KNOWLEDGE_SYNONYM_INVALID: {
    status: 422,
    retryable: false,
    message: 'The synonym mapping is invalid.',
  },
  KNOWLEDGE_PROVIDER_CONTRACT_INVALID: {
    status: 502,
    retryable: true,
    message: 'The provider response does not match the declared contract.',
  },
  KNOWLEDGE_PROVIDER_CONFIG_INVALID: {
    status: 422,
    retryable: false,
    message: 'The provider configuration does not match the local contract.',
  },
  KNOWLEDGE_CURSOR_INVALID: {
    status: 409,
    retryable: false,
    message: 'The connector cursor is invalid or expired.',
  },
  KNOWLEDGE_RATE_LIMITED: {
    status: 429,
    retryable: true,
    message: 'The workspace rate limit was exceeded.',
  },
  KNOWLEDGE_QUOTA_EXCEEDED: {
    status: 429,
    retryable: false,
    message: 'The workspace quota was exceeded.',
  },
  KNOWLEDGE_PAYLOAD_TOO_LARGE: {
    status: 413,
    retryable: false,
    message: 'The uploaded content exceeds the configured limit.',
  },
  KNOWLEDGE_RANGE_NOT_SATISFIABLE: {
    status: 416,
    retryable: false,
    message: 'The requested byte range cannot be satisfied.',
  },
  KNOWLEDGE_UNSUPPORTED_CONTENT: {
    status: 422,
    retryable: false,
    message: 'The content type or provider capability is unsupported.',
  },
  KNOWLEDGE_PAGE_LIMIT: {
    status: 422,
    retryable: false,
    message: 'The document page limit was exceeded.',
  },
  KNOWLEDGE_DEPENDENCY_UNAVAILABLE: {
    status: 503,
    retryable: true,
    message: 'A required dependency is unavailable.',
  },
  KNOWLEDGE_DEPENDENCY_TIMEOUT: {
    status: 504,
    retryable: true,
    message: 'A required dependency timed out.',
  },
  KNOWLEDGE_MODEL_FAILED: {
    status: 502,
    retryable: true,
    message: 'The model gateway failed.',
  },
  KNOWLEDGE_MODEL_OUTPUT_INVALID: {
    status: 502,
    retryable: true,
    message: 'The model output is invalid.',
  },
  KNOWLEDGE_JOB_FAILED: {
    status: 409,
    retryable: false,
    message: 'The job is failed or not in an allowed state.',
  },
  KNOWLEDGE_PARTIAL_SUCCESS: {
    status: 207,
    retryable: false,
    message: 'The operation completed with partial success.',
  },
  KNOWLEDGE_INTERNAL_ERROR: {
    status: 500,
    retryable: true,
    message: 'An internal error occurred.',
  },
} as const satisfies Record<string, KnowledgeErrorDefinition>;

export const KNOWLEDGE_ERROR_CODES = Object.freeze(
  Object.keys(KNOWLEDGE_ERROR_CATALOG) as KnowledgeErrorCode[],
);

export function isKnowledgeErrorCode(value: string): value is KnowledgeErrorCode {
  return Object.hasOwn(KNOWLEDGE_ERROR_CATALOG, value);
}

export function knowledgeErrorDefinition(code: KnowledgeErrorCode): KnowledgeErrorDefinition {
  return KNOWLEDGE_ERROR_CATALOG[code as keyof typeof KNOWLEDGE_ERROR_CATALOG];
}

export class KnowledgeApiError extends Error {
  constructor(readonly problem: KnowledgeProblem) {
    super(`${problem.error.code}: ${problem.error.message}`);
    this.name = 'KnowledgeApiError';
  }
}

export interface CreateKnowledgeErrorInput {
  code: KnowledgeErrorCode;
  requestId: string;
  traceId: string;
  details?: Record<string, unknown>;
  message?: string;
  retryable?: boolean;
}

export function createKnowledgeError(input: CreateKnowledgeErrorInput): KnowledgeApiError {
  if (!isKnowledgeErrorCode(input.code)) {
    return createKnowledgeError({
      code: 'KNOWLEDGE_INTERNAL_ERROR',
      requestId: input.requestId,
      traceId: input.traceId,
      details: { invalidErrorCode: String(input.code) },
    });
  }
  const definition = knowledgeErrorDefinition(input.code);
  const error: KnowledgeErrorBody = {
    code: input.code,
    message: input.message ?? definition.message,
    retryable: input.retryable ?? definition.retryable,
    details: input.details ?? {},
  };
  const problem = KnowledgeProblemSchema.parse({
    success: false,
    error,
    traceId: input.traceId,
    requestId: input.requestId,
  });
  return new KnowledgeApiError(problem);
}
