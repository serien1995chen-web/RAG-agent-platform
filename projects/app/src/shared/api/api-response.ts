import type { ApiResponse } from '@kb/contracts';

/** 成功响应统一信封（设计文档 12.3）。 */
export function successResponse<T>(data: T, requestId: string): ApiResponse<T> {
  return {
    code: 200,
    statusText: 'success',
    message: '',
    messageKey: 'common.success',
    params: {},
    data,
    errorType: null,
    retryable: null,
    severity: null,
    requestId,
  };
}
