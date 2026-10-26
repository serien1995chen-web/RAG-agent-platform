import type { KnowledgeErrorCode } from '@kb/contracts';
import type { MessageKey } from './messages';

export const ERROR_MESSAGE_KEYS = {
  KNOWLEDGE_AUTH_REQUIRED: 'errors.authRequired',
  KNOWLEDGE_FORBIDDEN: 'errors.forbidden',
  KNOWLEDGE_NOT_FOUND: 'errors.notFound',
  KNOWLEDGE_VALIDATION_FAILED: 'errors.validationFailed',
  KNOWLEDGE_CONFLICT: 'errors.conflict',
  KNOWLEDGE_REFERENCE_CONFLICT: 'errors.referenceConflict',
  KNOWLEDGE_SYNONYM_INVALID: 'errors.synonymInvalid',
  KNOWLEDGE_PROVIDER_CONTRACT_INVALID: 'errors.providerContractInvalid',
  KNOWLEDGE_PROVIDER_CONFIG_INVALID: 'errors.providerConfigInvalid',
  KNOWLEDGE_CURSOR_INVALID: 'errors.cursorInvalid',
  KNOWLEDGE_RATE_LIMITED: 'errors.rateLimited',
  KNOWLEDGE_QUOTA_EXCEEDED: 'errors.quotaExceeded',
  KNOWLEDGE_PAYLOAD_TOO_LARGE: 'errors.payloadTooLarge',
  KNOWLEDGE_RANGE_NOT_SATISFIABLE: 'errors.rangeNotSatisfiable',
  KNOWLEDGE_UNSUPPORTED_CONTENT: 'errors.unsupportedContent',
  KNOWLEDGE_PAGE_LIMIT: 'errors.pageLimit',
  KNOWLEDGE_DEPENDENCY_UNAVAILABLE: 'errors.dependencyUnavailable',
  KNOWLEDGE_DEPENDENCY_TIMEOUT: 'errors.dependencyTimeout',
  KNOWLEDGE_MODEL_FAILED: 'errors.modelFailed',
  KNOWLEDGE_MODEL_OUTPUT_INVALID: 'errors.modelOutputInvalid',
  KNOWLEDGE_JOB_FAILED: 'errors.jobFailed',
  KNOWLEDGE_PARTIAL_SUCCESS: 'errors.partialSuccess',
  KNOWLEDGE_INTERNAL_ERROR: 'errors.internal',
} as const satisfies Record<KnowledgeErrorCode, MessageKey>;

export function errorMessageKey(code: KnowledgeErrorCode | 'UNKNOWN_ERROR'): MessageKey {
  if (code === 'UNKNOWN_ERROR') return 'errors.unknown';
  return ERROR_MESSAGE_KEYS[code as keyof typeof ERROR_MESSAGE_KEYS] ?? 'errors.unknown';
}
