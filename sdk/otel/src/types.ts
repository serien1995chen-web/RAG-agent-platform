export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface OtelConfig {
  serviceName: string;
  enabled: boolean;
  exporterEndpointRef?: string;
  logLevel: LogLevel;
}

export interface OtelInitStatus {
  enabled: boolean;
  reason: string;
}

/** 设计 15.1：13 类 Instrument 名称（PostgreSQL/pgvector 合一）。 */
export type SpanInstrumentName =
  | 'http'
  | 'mongodb'
  | 'redis'
  | 'postgresql'
  | 's3'
  | 'parse'
  | 'qa'
  | 'vector'
  | 'delete'
  | 'sync'
  | 'search'
  | 'migration'
  | 'reconcile';

/** 设计 15.1 附录 B：Instrument 定义（低基数白名单与显式禁止属性）。 */
export interface SpanInstrumentDefinition {
  name: SpanInstrumentName;
  allowedAttributes: readonly string[];
  forbiddenAttributes: readonly string[];
}

/** 设计 15.2：指标类型。 */
export type MetricType = 'Counter' | 'Histogram' | 'Gauge';

/** 设计 15.2：指标字典元组（名称 / 类型 / 单位 / 属性白名单）。 */
export interface MetricDefinition {
  name: string;
  type: MetricType;
  unit: string;
  allowedAttributes: readonly string[];
}

/** 设计 15.3：结构化日志固定字段字典（13）。 */
export type LogFieldName =
  | 'requestId'
  | 'teamId'
  | 'tmbId'
  | 'route'
  | 'method'
  | 'resourceType'
  | 'resourceId'
  | 'operation'
  | 'durationMs'
  | 'httpStatus'
  | 'errorCode'
  | 'errorType'
  | 'retryCount';

/** 设计 15.5：低基数告警信号类别（7）。 */
export type AlertSignalKind =
  | 'queue_backlog'
  | 'permanent_error'
  | 'reconcile_failure'
  | 'delete_failure'
  | 'provider_failure'
  | 'tenant_anomaly'
  | 'dependency_unavailable';

/** 设计 15.5：告警信号（仅低基数字段，不含 teamId / 密钥 / 正文）。 */
export interface AlertSignal {
  kind: AlertSignalKind;
  fields: Record<string, string | number | boolean>;
  timestamp: string;
}

/** exporter 落地状态（registered = 已装配；degraded = 降级；disabled = 未启用）。 */
export type OtelExportState = 'registered' | 'degraded' | 'disabled';
