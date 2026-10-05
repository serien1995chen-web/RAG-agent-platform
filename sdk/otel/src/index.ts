/**
 * @kb/otel — trace / metrics / logs 三独立入口（CR-REF-07，设计文档 15.x）。
 * Phase 4 在此包内落地三个独立入口；导出失败不得影响业务。
 */
export const PACKAGE_NAME = '@kb/otel' as const;
