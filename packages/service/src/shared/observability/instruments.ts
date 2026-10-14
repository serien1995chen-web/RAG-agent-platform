import type { DatasetMetricsPort } from '../../ports/capabilities';

/**
 * 设计 15.1 / 15.2：指标字典与统一记录入口（业务只调用 recordMetric）。
 * teamId 不出现在任何属性白名单；越界属性键丢弃（指标仍记录）；未知指标名不记录。
 */
export type MetricType = 'Counter' | 'Histogram' | 'Gauge';

export interface MetricDefinitionEntry {
  name: string;
  type: MetricType;
  unit: string;
  allowedAttributes: readonly string[];
}

/** 设计 15.2 附录 A：43 指标清单（名称 / 类型 / 单位 / 属性白名单）。 */
export const METRIC_DEFINITIONS: readonly MetricDefinitionEntry[] = [
  {
    name: 'dataset_http_requests_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['method', 'route', 'status'],
  },
  {
    name: 'dataset_http_request_duration_seconds',
    type: 'Histogram',
    unit: '秒',
    allowedAttributes: ['method', 'route'],
  },
  {
    name: 'dataset_training_tasks_total',
    type: 'Counter',
    unit: '个',
    allowedAttributes: ['mode', 'result'],
  },
  { name: 'dataset_queue_depth', type: 'Gauge', unit: '个', allowedAttributes: ['queue'] },
  {
    name: 'dataset_lease_events_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['mode', 'event'],
  },
  {
    name: 'dataset_vector_operations_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['operation', 'result'],
  },
  {
    name: 'dataset_fulltext_operations_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['operation', 'result'],
  },
  {
    name: 'dataset_delete_resources_total',
    type: 'Counter',
    unit: '个',
    allowedAttributes: ['resource', 'result'],
  },
  {
    name: 'dataset_reconcile_findings_total',
    type: 'Counter',
    unit: '个',
    allowedAttributes: ['kind', 'result'],
  },
  {
    name: 'dataset_migration_progress',
    type: 'Gauge',
    unit: '批',
    allowedAttributes: ['version', 'state'],
  },
  {
    name: 'dataset_extension_calls_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['port', 'result'],
  },
  {
    name: 'dataset_usage_events_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['source', 'resourceType'],
  },
  {
    name: 'dataset_search_requests_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['mode', 'result'],
  },
  {
    name: 'dataset_search_degraded_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['stage', 'reason'],
  },
  {
    name: 'dataset_search_token_budget_used',
    type: 'Histogram',
    unit: 'token',
    allowedAttributes: ['mode'],
  },
  {
    name: 'dataset_rerank_latency_ms',
    type: 'Histogram',
    unit: '毫秒',
    allowedAttributes: ['model', 'result'],
  },
  { name: 'dataset_link_read_total', type: 'Counter', unit: '次', allowedAttributes: ['result'] },
  {
    name: 'dataset_link_blocked_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['reason'],
  },
  {
    name: 'dataset_tag_ops_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['op', 'result'],
  },
  {
    name: 'dataset_export_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['scope', 'result'],
  },
  { name: 'dataset_import_rows_total', type: 'Counter', unit: '行', allowedAttributes: ['result'] },
  { name: 'dataset_s3_ttl_pending', type: 'Gauge', unit: '个', allowedAttributes: ['state'] },
  {
    name: 'dataset_s3_ttl_deleted_total',
    type: 'Counter',
    unit: '个',
    allowedAttributes: ['result'],
  },
  {
    name: 'dataset_s3_ttl_failed_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['reason'],
  },
  {
    name: 'dataset_s3_ttl_register_failed_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['result'],
  },
  {
    name: 'dataset_s3_orphan_objects_found_total',
    type: 'Counter',
    unit: '个',
    allowedAttributes: ['prefix'],
  },
  {
    name: 'dataset_s3_orphan_actions_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['action'],
  },
  {
    name: 'dataset_external_calls_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['dep', 'result'],
  },
  { name: 'dataset_mock_mode_active', type: 'Gauge', unit: '0/1', allowedAttributes: ['dep'] },
  {
    name: 'dataset_process_cpu_seconds_total',
    type: 'Counter',
    unit: '秒',
    allowedAttributes: ['role', 'mode'],
  },
  {
    name: 'dataset_process_resident_memory_bytes',
    type: 'Gauge',
    unit: 'bytes',
    allowedAttributes: ['role'],
  },
  {
    name: 'dataset_process_uptime_seconds',
    type: 'Gauge',
    unit: '秒',
    allowedAttributes: ['role'],
  },
  {
    name: 'dataset_redis_connection_errors_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['operation'],
  },
  {
    name: 'dataset_http_errors_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['family', 'status'],
  },
  {
    name: 'dataset_provider_requests_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['provider', 'result'],
  },
  {
    name: 'dataset_provider_duration_seconds',
    type: 'Histogram',
    unit: '秒',
    allowedAttributes: ['provider', 'operation'],
  },
  {
    name: 'dataset_search_candidates',
    type: 'Histogram',
    unit: '个',
    allowedAttributes: ['mode', 'path'],
  },
  {
    name: 'dataset_search_duration_seconds',
    type: 'Histogram',
    unit: '秒',
    allowedAttributes: ['mode', 'degraded'],
  },
  { name: 'dataset_search_results', type: 'Histogram', unit: '个', allowedAttributes: ['mode'] },
  {
    name: 'dataset_storage_orphans',
    type: 'Gauge',
    unit: '个',
    allowedAttributes: ['store', 'kind'],
  },
  {
    name: 'dataset_ttl_cleanup_total',
    type: 'Counter',
    unit: '个',
    allowedAttributes: ['store', 'result'],
  },
  {
    name: 'dataset_scheduler_reconcile_total',
    type: 'Counter',
    unit: '个',
    allowedAttributes: ['action', 'result'],
  },
  {
    name: 'dataset_error_total',
    type: 'Counter',
    unit: '次',
    allowedAttributes: ['severity', 'category', 'family'],
  },
];

export const METRIC_NAMES: readonly string[] = METRIC_DEFINITIONS.map((entry) => entry.name);

/** 设计 15.1 附录 B：13 类 Instrument 名称。 */
export const INSTRUMENT_CLASSES: readonly string[] = [
  'http',
  'mongodb',
  'redis',
  'postgresql',
  's3',
  'parse',
  'qa',
  'vector',
  'delete',
  'sync',
  'search',
  'migration',
  'reconcile',
];

const METRIC_BY_NAME = new Map(METRIC_DEFINITIONS.map((entry) => [entry.name, entry]));

let droppedMetrics = 0;

export function metricDropCount(): number {
  return droppedMetrics;
}

/**
 * 设计 15.2：统一指标记录入口，永不抛出。
 * - 未知指标名 → `{ recorded: false, dropped: 'unknown_metric' }`；
 * - 越界属性键丢弃（指标本身仍记录）→ `{ recorded: true, dropped: 'attribute_not_allowed' }`；
 * - Port 记录异常 → `{ recorded: false }` 且丢弃计数 +1。
 */
export function recordMetric(
  metrics: DatasetMetricsPort,
  name: string,
  value: number,
  attributes: Record<string, string>,
): { recorded: boolean; dropped?: 'unknown_metric' | 'attribute_not_allowed' } {
  const definition = METRIC_BY_NAME.get(name);
  if (definition === undefined) {
    return { recorded: false, dropped: 'unknown_metric' };
  }
  let attributeDropped = false;
  const allowed: Record<string, string> = {};
  for (const [key, attributeValue] of Object.entries(attributes)) {
    if (definition.allowedAttributes.includes(key)) {
      allowed[key] = attributeValue;
    } else {
      attributeDropped = true;
    }
  }
  try {
    metrics.record(name, value, allowed);
  } catch {
    droppedMetrics += 1;
    return { recorded: false };
  }
  return attributeDropped
    ? { recorded: true, dropped: 'attribute_not_allowed' }
    : { recorded: true };
}
