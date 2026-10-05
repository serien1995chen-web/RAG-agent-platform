/**
 * @kb/otel — trace / metrics / logs 三独立入口（CR-REF-07，设计文档 15.x）。
 * 导出失败不得影响业务；业务只调用统一 helper，不直接持有 exporter。
 */
export const PACKAGE_NAME = '@kb/otel' as const;

export { initMetrics } from './metrics';
export { createSafeLogger, isSensitiveLogFields } from './logger';
export type { SafeLogger } from './logger';
export { getTracer, initTracing } from './tracing';
export type { LogLevel, OtelConfig, OtelInitStatus } from './types';
