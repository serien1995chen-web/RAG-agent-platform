export { validateTenantContext } from './auth/tenant-context';
export type {
  AuthType,
  PermissionContext,
  RequestContext,
  TenantContext,
} from './auth/tenant-context';

export {
  ApiErrorException,
  classifyRetryableError,
  createApiError,
  createSkeletonError,
  toApiResponse,
} from './errors/index';
export type { ApiError, ApiResponse, CreateApiErrorInput } from './errors/index';

export { defineIndex, getDeclaredIndexes, listDeclaredIndexes } from './persistence/define-index';
export type { IndexDeclaration } from './persistence/define-index';
