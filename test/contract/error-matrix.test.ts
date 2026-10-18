import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  ERROR_CATALOG,
  ROUTE_REGISTRY,
  createApiError,
  getErrorMeta,
} from '../../packages/contracts/src/index';

/**
 * 错误矩阵 / 兼容 / i18n 契约（设计 12.4/12.4.1/12.4.2/12.7，任务 P8-01-S06）：
 * TEST-ERROR-MATRIX-001 / TEST-ERROR-COMPAT-001 / TEST-ERROR-I18N-001 / ACC-ERR-001。
 * N5-A：API-HEALTH-001 为 live probe 例外，允许空错误列。
 */

const LIVE_PROBE_ROUTE = 'API-HEALTH-001';
const ALLOWED_HTTP_STATUS = [400, 403, 404, 409, 410, 413, 422, 429, 500, 502, 503, 504];
const ALLOWED_RETRYABILITY = ['retryable', 'no-retry', 'manual'];
const ALLOWED_SEVERITY = ['warning', 'error', 'fatal'];

/** 从 `{a,b}` / `{missing[]}` 形式的 paramsSchema 提取参数名。 */
function paramNames(schema: string): string[] {
  return [...schema.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)].map((match) => match[0]);
}

describe('错误矩阵与 i18n 契约（ACC-ERR-001）', () => {
  it('TEST-ERROR-MATRIX-001 每条路由至少 1 个 501xxx 业务码且全部登记（N5-A 例外）', () => {
    const registered = new Set(ERROR_CATALOG.map((entry) => entry.code));
    const missing = ROUTE_REGISTRY.filter(
      (route) =>
        route.routeId !== LIVE_PROBE_ROUTE &&
        !route.errorCodes.some((code) => code >= 501001 && code <= 501072),
    ).map((route) => route.routeId);
    expect(missing).toEqual([]);

    const unregistered = ROUTE_REGISTRY.flatMap((route) =>
      route.errorCodes
        .filter((code) => !registered.has(code))
        .map((code) => `${route.routeId}: ${code}`),
    );
    expect(unregistered).toEqual([]);
    expect(ERROR_CATALOG).toHaveLength(72);
  });

  it('TEST-ERROR-COMPAT-001 错误字段稳定：HTTP/retryable/severity 与 12.4 对齐', () => {
    for (const entry of ERROR_CATALOG) {
      expect(entry.code, `code ${entry.code}`).toBeGreaterThanOrEqual(501001);
      expect(entry.code, `code ${entry.code}`).toBeLessThanOrEqual(501072);
      expect(ALLOWED_HTTP_STATUS, `code ${entry.code}`).toContain(entry.httpStatus);
      expect(ALLOWED_RETRYABILITY, `code ${entry.code}`).toContain(entry.retryable);
      expect(ALLOWED_SEVERITY, `code ${entry.code}`).toContain(entry.severity);
      expect(entry.description.trim().length, `code ${entry.code}`).toBeGreaterThan(0);
      expect(entry.paramsSchema, `code ${entry.code}`).toMatch(/^\{.+\}$/);
    }

    const error = createApiError({
      code: 501016,
      requestId: 'req-error-compat',
      params: { operation: 'rebuild' },
    });
    expect(ApiErrorSchema.parse(error)).toEqual(error);
    expect(error.retryable).toBe('retryable');
    expect(error.severity).toBe('error');
    expect(getErrorMeta(501016)?.httpStatus).toBe(503);
  });

  it('TEST-ERROR-I18N-001 messageKey+params 可渲染全部 72 个错误，无缺失 key', () => {
    const seenKeys = new Set<string>();
    for (const entry of ERROR_CATALOG) {
      expect(entry.messageKey, `code ${entry.code}`).toMatch(/^dataset\./);
      expect(seenKeys.has(entry.messageKey), `duplicate key ${entry.messageKey}`).toBe(false);
      seenKeys.add(entry.messageKey);

      const schemaNames = paramNames(entry.paramsSchema);
      expect(schemaNames.length, `code ${entry.code}`).toBeGreaterThan(0);
      for (const name of schemaNames) {
        const declared = entry.params.map((param) => param.replace(/\[\]$/, ''));
        expect(declared, `code ${entry.code} param ${name}`).toContain(name);
      }

      const params = Object.fromEntries(
        schemaNames.map((name) => [name, entry.paramsSchema.includes(`${name}[]`) ? [name] : name]),
      );
      const error = createApiError({
        code: entry.code,
        requestId: `req-${entry.code}`,
        params,
      });
      expect(error.messageKey, `code ${entry.code}`).toBe(entry.messageKey);
      expect(Object.keys(error.params).sort(), `code ${entry.code}`).toEqual(schemaNames.sort());
      expect(error.message.trim().length, `code ${entry.code}`).toBeGreaterThan(0);
    }
    expect(seenKeys.size).toBe(72);
  });
});
