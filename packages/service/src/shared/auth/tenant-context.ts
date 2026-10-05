/**
 * 认证主体与租户上下文入口（设计文档 12.2 / 7.6）。
 * teamId / tmbId 只能由认证主体解析得到，禁止请求体直接声明。
 */
export { validateTenantContext } from '../../ports/types';
export type { AuthType, PermissionContext, RequestContext, TenantContext } from '../../ports/types';
