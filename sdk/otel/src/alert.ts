import type { AlertSignal, AlertSignalKind } from './types';

export type { AlertSignal, AlertSignalKind } from './types';

/** 设计 15.5 附录 D：7 类低基数告警信号。 */
export const ALERT_KINDS: readonly AlertSignalKind[] = [
  'queue_backlog',
  'permanent_error',
  'reconcile_failure',
  'delete_failure',
  'provider_failure',
  'tenant_anomaly',
  'dependency_unavailable',
];

/** 设计 15.5：仅允许的低基数白名单字段（不含 teamId / tmbId / 密钥 / 正文）。 */
const ALERT_ALLOWED_FIELDS: readonly string[] = ['count', 'dependency', 'stage', 'queue', 'reason'];

/**
 * 设计 15.5：构造低基数告警信号；白名单外字段（含 teamId / 密钥类 / 正文类）整键丢弃。
 */
export function createAlertSignal(
  kind: AlertSignalKind,
  fields: Record<string, string | number | boolean> = {},
): AlertSignal {
  const filtered: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (ALERT_ALLOWED_FIELDS.includes(key)) filtered[key] = value;
  }
  return { kind, fields: filtered, timestamp: new Date().toISOString() };
}

/**
 * 设计 15.5：投递告警信号；未配置 sink 或 sink 故障返回 false，不阻塞业务。
 */
export async function emitAlert(
  signal: AlertSignal,
  sink: { emit(signal: AlertSignal): Promise<void> } | undefined,
): Promise<boolean> {
  if (sink === undefined) return false;
  try {
    await sink.emit(signal);
    return true;
  } catch {
    return false;
  }
}
