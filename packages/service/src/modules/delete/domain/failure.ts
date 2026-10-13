import { ApiErrorException, classifyRetryableError } from '@kb/contracts';

const MAX_FAILURE_ATTEMPTS = 10;

/**
 * 失败事实记录（设计 10.11 dataset_delete_failures / AB §4.4）：
 * 每次删除阶段失败一条，字段与 Schema 一一对应。
 */
export interface FailureRecord {
  resourceType: string;
  resourceId: string;
  stage: string;
  attempt: number;
  errorClass: string;
  retryable: boolean;
  lastError: string;
}

export interface FailureClassification {
  errorClass: string;
  retryable: boolean;
  lastError: string;
}

/** 失败分页稳定规则：按 createTime+_id 升序游标（id 为 Mongo _id）。 */
export const FAILURE_CURSOR_ORDER = ['createTime', '_id'] as const;

/** 失败超限映射：进入对账 finding kind `cross-store-failed`。 */
export const FAILURE_EXHAUSTED_KIND = 'cross-store-failed' as const;

export function isFailureExhausted(attempt: number): boolean {
  return attempt >= MAX_FAILURE_ATTEMPTS;
}

/**
 * 失败分类（复用统一分类器）：errorClass 取稳定 messageKey/错误名，
 * retryable 仅由 classifyRetryableError 判定。
 */
export function classifyFailureError(error: unknown): FailureClassification {
  const retryable = classifyRetryableError(error) === 'retryable';
  if (error instanceof ApiErrorException) {
    return {
      errorClass: error.error.messageKey,
      retryable,
      lastError: `${error.error.code} ${error.error.messageKey}`,
    };
  }
  if (error instanceof Error) {
    return { errorClass: error.name, retryable, lastError: error.message };
  }
  return { errorClass: typeof error, retryable, lastError: String(error) };
}
