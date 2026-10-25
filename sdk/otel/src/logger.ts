import pino from 'pino';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import type { LogRecordExporter } from '@opentelemetry/sdk-logs';
import type { LogFieldName, LogLevel, SafeLogFields, SafeTelemetryValue } from './types';

export interface SafeLogger {
  log(event: string, fields: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): SafeLogger;
  /** 设计 15.3：敏感字段整条丢弃与序列化失败的累计计数（NOOP logger 恒 0）。 */
  droppedRecords(): number;
}

/** 设计 15.3：固定字段字典（13）。 */
export const LOG_FIELD_DICTIONARY: readonly LogFieldName[] = [
  'requestId',
  'workspaceId',
  'knowledgeSpaceId',
  'route',
  'method',
  'resourceType',
  'resourceId',
  'operation',
  'durationMs',
  'httpStatus',
  'errorCode',
  'errorType',
  'retryCount',
];

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|authorization|cookie|credential|apikey|api_key|signedurl|signed_url|accesskey|providerresponse|rawresponse|filecontent|filebody|documentcontent|rawtext|body|payload)/i;

const SENSITIVE_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /(?:mongodb(?:\+srv)?|postgres(?:ql)?|redis|rediss|amqp|amqps):\/\//i,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /[?&](?:x-amz-signature|x-amz-credential|signature|sig|token|access_token)=/i,
  /\b(?:kb_console_session|session|authorization|cookie|token)=/i,
];

function isSafeTelemetryValue(value: unknown): value is SafeTelemetryValue {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/** 脱敏失败时拒绝输出：字段名命中敏感模式即整条日志丢弃。 */
export function isSensitiveLogFields(fields: Record<string, unknown>): boolean {
  const stack: unknown[] = [fields];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (typeof current !== 'object' || current === null) continue;
    for (const [key, value] of Object.entries(current)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) return true;
      if (typeof value === 'string' && isSensitiveValue(value)) return true;
      if (typeof value === 'object' && value !== null) stack.push(value);
    }
  }
  return false;
}

export function sanitizeLogFields(fields: Record<string, unknown>): {
  fields: SafeLogFields;
  dropped: number;
} {
  const safeFields: SafeLogFields = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (!(LOG_FIELD_DICTIONARY as readonly string[]).includes(key)) {
      dropped += 1;
      continue;
    }
    if (!isSafeTelemetryValue(value)) {
      dropped += 1;
      continue;
    }
    if (typeof value === 'string' && isSensitiveValue(value)) {
      dropped += 1;
      continue;
    }
    safeFields[key as LogFieldName] = value;
  }
  return { fields: safeFields, dropped };
}

const NOOP_LOGGER: SafeLogger = {
  log: () => undefined,
  child: () => NOOP_LOGGER,
  droppedRecords: () => 0,
};

/**
 * logs 独立入口（设计文档 15.3）。
 * logger 初始化或写入失败时返回 no-op logger，不阻塞主业务；敏感字段整条拒绝输出。
 */
export function createSafeLogger(config: {
  name: string;
  level: LogLevel;
  enabled?: boolean;
  destination?: pino.DestinationStream;
}): SafeLogger {
  if (config.enabled === false) return NOOP_LOGGER;
  try {
    const logger = pino(
      {
        name: config.name,
        level: config.level,
        base: undefined,
        redact: {
          paths: ['*.password', '*.secret', '*.token', '*.authorization'],
          censor: '[redacted]',
        },
      },
      config.destination,
    );
    const counter = { dropped: 0 };
    const wrap = (instance: pino.Logger): SafeLogger => ({
      log(event, fields) {
        try {
          if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
            counter.dropped += 1;
            return;
          }
          const sanitized = sanitizeLogFields(fields);
          counter.dropped += sanitized.dropped;
          instance.info({ event, ...sanitized.fields });
        } catch {
          // 序列化失败时拒绝输出，不阻塞业务。
          counter.dropped += 1;
        }
      },
      child(bindings) {
        const sanitized = sanitizeLogFields(bindings);
        counter.dropped += sanitized.dropped;
        return wrap(instance.child(sanitized.fields));
      },
      droppedRecords: () => counter.dropped,
    });
    return wrap(logger);
  } catch {
    return NOOP_LOGGER;
  }
}

/** 设计 15.7 / 6.1.6：OTLP log exporter 工厂（仅构造对象，不发起网络请求）。 */
export function createOtlpLogExporter(endpointUrl: string): LogRecordExporter {
  return new OTLPLogExporter({ url: endpointUrl });
}
