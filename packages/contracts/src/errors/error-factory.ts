import { z } from 'zod';
import {
  ApiErrorSchema,
  type ApiError,
  type ApiResponse,
  type ErrorFamily,
  type Retryability,
} from '../common/api-response';
import {
  getErrorMeta,
  SKELETON_INTERNAL_ERROR,
  SKELETON_NOT_IMPLEMENTED,
  type ErrorCatalogEntry,
} from './error-catalog';

export class ApiErrorException extends Error {
  readonly error: ApiError;

  constructor(error: ApiError) {
    super(`${error.code} ${error.messageKey}`);
    this.name = 'ApiErrorException';
    this.error = error;
  }
}

export interface CreateApiErrorInput {
  code: number;
  requestId: string;
  params?: Record<string, unknown>;
  message?: string;
  zodError?: unknown;
}

const FAMILY_PREFIXES: readonly (readonly [string, ErrorFamily])[] = [
  ['dataset.acl.', 'permission'],
  ['dataset.admin.', 'permission'],
  ['dataset.task.', 'task'],
  ['dataset.vector.', 'storage'],
  ['dataset.storage.', 'storage'],
  ['dataset.provider.', 'provider'],
  ['dataset.api_dataset.', 'provider'],
  ['dataset.qa.', 'provider'],
  ['dataset.extension.', 'extension'],
  ['dataset.notification.', 'extension'],
  ['dataset.migration.', 'migration'],
  ['dataset.reconcile.', 'internal'],
  ['dataset.audit.', 'internal'],
  ['dataset.license.', 'internal'],
  ['dataset.import.', 'limit'],
  ['dataset.quota_exceeded', 'limit'],
  ['dataset.data.duplicate', 'conflict'],
  ['dataset.external_file.', 'conflict'],
  ['dataset.delete.', 'conflict'],
  ['dataset.delete_in_progress', 'conflict'],
  ['dataset.rebuild_in_progress', 'conflict'],
  ['dataset.version_conflict', 'conflict'],
  ['dataset.duplicate_name', 'conflict'],
  ['dataset.tag.', 'conflict'],
  ['dataset.path.', 'conflict'],
];

function familyOf(meta: ErrorCatalogEntry): ErrorFamily {
  for (const [prefix, family] of FAMILY_PREFIXES) {
    if (meta.messageKey.startsWith(prefix)) return family;
  }
  return 'validation';
}

export function createApiError(input: CreateApiErrorInput): ApiError {
  const meta = getErrorMeta(input.code);
  if (!meta) {
    throw new ApiErrorException({
      code: SKELETON_NOT_IMPLEMENTED,
      statusText: 'skeleton.unknown_error_code',
      messageKey: 'skeleton.not_implemented',
      params: { unknownCode: input.code },
      message: `error code ${input.code} is not registered in the frozen matrix`,
      errorType: 'internal',
      retryable: 'manual',
      severity: 'fatal',
      requestId: input.requestId,
    });
  }
  const error: ApiError = {
    code: meta.code,
    statusText: meta.messageKey,
    messageKey: meta.messageKey,
    params: input.params ?? {},
    message: input.message ?? meta.description,
    errorType: familyOf(meta),
    retryable: meta.retryable,
    severity: meta.severity,
    requestId: input.requestId,
  };
  if (input.zodError !== undefined) error.zodError = input.zodError;
  return ApiErrorSchema.parse(error);
}

/** 骨架期未实现语义：路由 / Port / 操作三个占位维度。 */
export function createSkeletonError(
  target: { route?: string; port?: string; operation?: string },
  requestId = 'skeleton',
): ApiError {
  return createApiError({
    code: SKELETON_NOT_IMPLEMENTED,
    requestId,
    params: { ...target },
  });
}

/** 未映射的内部错误统一入口：HTTP 500 + 501998，不返回原始堆栈。 */
export function createInternalError(operation: string, requestId: string): ApiError {
  return createApiError({
    code: SKELETON_INTERNAL_ERROR,
    requestId,
    params: { operation },
  });
}

const RETRYABLE_SYSTEM_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** 设计文档 18.6：重试分类只能走统一入口，禁止调用方自行推断。 */
export function classifyRetryableError(error: unknown): Retryability {
  if (error instanceof ApiErrorException) return error.error.retryable;
  if (error instanceof z.ZodError) return 'no-retry';
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const declared = record.retryable;
    if (declared === 'retryable' || declared === 'no-retry' || declared === 'manual') {
      return declared;
    }
    const status = record.status ?? record.statusCode ?? record.httpStatus;
    if (typeof status === 'number' && (status === 429 || status >= 500)) return 'retryable';
    const code = record.code;
    if (typeof code === 'number' && (code === 429 || code >= 500)) return 'retryable';
    if (typeof code === 'string' && RETRYABLE_SYSTEM_CODES.has(code)) return 'retryable';
  }
  return 'manual';
}

export function toApiResponse<T>(error: ApiError, data: T | null = null): ApiResponse<T> {
  return {
    code: error.code,
    statusText: error.statusText,
    message: error.message,
    messageKey: error.messageKey,
    params: error.params,
    data,
    errorType: error.errorType,
    retryable: error.retryable,
    severity: error.severity,
    requestId: error.requestId,
    ...(error.zodError !== undefined ? { zodError: error.zodError } : {}),
  };
}
