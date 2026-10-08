/**
 * persistence/tenant 子目录出口（P2-03）。
 * 装配 barrel（persistence/index.ts、shared/index.ts）由后续任务负责，不在本任务内修改。
 */
export { tenantScopedModel } from '../tenant-scoped-model';
export type { TenantScopedModel } from '../tenant-scoped-model';
export { withMongoTransaction } from '../with-mongo-transaction';
