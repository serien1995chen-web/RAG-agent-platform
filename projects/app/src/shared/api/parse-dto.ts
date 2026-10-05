import { ApiErrorException, createSkeletonError, dtoRegistry } from '@kb/contracts';

/**
 * 所有路由入参必须引用 12.8.2 注册表 DTO；未登记 DTO 属于骨架未覆盖，返回稳定 501999。
 * ZodError 由 withApiHandler 统一映射到该路由声明的 400 业务码。
 */
export function parseDto<T>(name: string, value: unknown): T {
  const schema = dtoRegistry[name];
  if (!schema) {
    throw new ApiErrorException(createSkeletonError({ operation: `dto:${name}` }, 'dto-registry'));
  }
  return schema.parse(value) as T;
}
