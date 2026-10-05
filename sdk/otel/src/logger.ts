import pino from 'pino';
import type { LogLevel } from './types';

export interface SafeLogger {
  log(event: string, fields: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): SafeLogger;
}

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|authorization|cookie|credential|apikey|api_key|signedurl|signed_url|accesskey)/i;

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
      if (typeof value === 'object' && value !== null) stack.push(value);
    }
  }
  return false;
}

const NOOP_LOGGER: SafeLogger = {
  log: () => undefined,
  child: () => NOOP_LOGGER,
};

/**
 * logs 独立入口（设计文档 15.3）。
 * logger 初始化或写入失败时返回 no-op logger，不阻塞主业务；敏感字段整条拒绝输出。
 */
export function createSafeLogger(config: {
  name: string;
  level: LogLevel;
  enabled?: boolean;
}): SafeLogger {
  if (config.enabled === false) return NOOP_LOGGER;
  try {
    const logger = pino({
      name: config.name,
      level: config.level,
      base: undefined,
      redact: {
        paths: ['*.password', '*.secret', '*.token', '*.authorization'],
        censor: '[redacted]',
      },
    });
    const wrap = (instance: pino.Logger): SafeLogger => ({
      log(event, fields) {
        try {
          if (isSensitiveLogFields(fields)) return;
          instance.info({ event, ...fields });
        } catch {
          // 序列化失败时拒绝输出，不阻塞业务。
        }
      },
      child: (bindings) => wrap(instance.child(bindings)),
    });
    return wrap(logger);
  } catch {
    return NOOP_LOGGER;
  }
}
