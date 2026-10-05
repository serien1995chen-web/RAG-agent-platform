/**
 * 统一错误入口（设计文档 18.6）：业务代码不得自行构造错误结构。
 */
export {
  ApiErrorException,
  classifyRetryableError,
  createApiError,
  createSkeletonError,
  toApiResponse,
} from '@kb/contracts';
export type { ApiError, ApiResponse, CreateApiErrorInput } from '@kb/contracts';
