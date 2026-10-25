/**
 * @kb/otel — trace / metrics / logs 三独立入口（CR-REF-07，设计文档 15.x）。
 * 导出失败不得影响业务；业务只调用统一 helper，不直接持有 exporter。
 */
export const PACKAGE_NAME = '@kb/otel' as const;

export { initMetrics } from './metrics';
export { createSafeLogger, isSensitiveLogFields, sanitizeLogFields } from './logger';
export type { SafeLogger } from './logger';
export { getTracer, initTracing } from './tracing';
export type {
  LogLevel,
  OtelConfig,
  OtelInitStatus,
  SafeAttributes,
  SafeLogFields,
  SafeTelemetryValue,
  TelemetryExportStatus,
  TelemetryState,
} from './types';

export {
  SPAN_INSTRUMENTS,
  SPAN_ALLOWED_ATTRIBUTE_KEYS,
  SPAN_CONTEXT_ATTRIBUTE_KEYS,
  startInstrumentSpan,
  setSpanStatusFromHttp,
  createOtlpTraceExporter,
} from './tracing';
export type { SpanInstrumentName, SpanInstrumentDefinition } from './tracing';
export {
  METRIC_LABEL_ALLOWED_KEYS,
  createOtlpMetricExporter,
  createOtlpMetricReader,
} from './metrics';
export { LOG_FIELD_DICTIONARY, createOtlpLogExporter } from './logger';
export {
  SENSITIVE_VALUE_PATTERNS,
  isSafeTelemetryValue,
  isSensitiveTelemetryValue,
  safeErrorAttributes,
  sanitizeTelemetryAttributes,
  sanitizeTelemetryEvent,
} from './redaction';
export { ALERT_KINDS, createAlertSignal, emitAlert } from './alert';
export type { AlertSignal, AlertSignalKind } from './alert';
export { configureTelemetry, createNoopTelemetry, createTelemetryRuntime } from './telemetry';
export type {
  SafeUsageEvent,
  TelemetryConfig,
  TelemetryContext,
  TelemetryDependencies,
  TelemetryRuntime,
} from './telemetry';
