import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTE_REGISTRY, routeMethods } from '../../packages/contracts/src/index';

/**
 * API 弃用兼容守卫（N4-A 条件式，设计 12.7 / 19.4.2）：
 * TEST-API-COMPAT-001 / ACC-API-002 / ACC-API-006。
 *
 * 当前 P8 基线无已弃用路由（deprecated 计数 0）；12 个自然月的运行时兼容场景
 * 需要真实调用链，本用例只做条件式守卫，未执行场景在《工作完成情况》如实标注。
 */

const repoRoot = resolve(import.meta.dirname, '../..');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

interface DeprecationAwareRoute {
  routeId: string;
  deprecated?: boolean;
  sunsetDate?: string;
}

interface OpenApiOperation {
  operationId?: string;
  deprecated?: boolean;
  sunsetDate?: string;
  'x-kb-route-id'?: string;
  [key: string]: unknown;
}

const openApiDocument = JSON.parse(
  readFileSync(join(repoRoot, 'packages/contracts/openapi/openapi.json'), 'utf8'),
) as { paths: Record<string, Record<string, OpenApiOperation>> };

const openApiOperations = Object.entries(openApiDocument.paths).flatMap(([path, operations]) =>
  Object.entries(operations)
    .filter(([method]) => HTTP_METHODS.has(method))
    .map(([method, operation]) => ({ path, method, operation })),
);

const routes = ROUTE_REGISTRY as readonly DeprecationAwareRoute[];
const deprecatedRoutes = routes.filter((route) => route.deprecated === true);

function isValidSunsetDate(value: string | undefined): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

describe('API 弃用兼容守卫（TEST-API-COMPAT-001 / ACC-API-002 / ACC-API-006）', () => {
  it('TEST-API-COMPAT-001 当前无已弃用路由：deprecated 计数为 0', () => {
    expect(deprecatedRoutes.map((route) => route.routeId)).toEqual([]);
    const openApiDeprecated = openApiOperations.filter(
      (entry) => entry.operation.deprecated === true,
    );
    expect(openApiDeprecated.map((entry) => entry.operation.operationId ?? entry.path)).toEqual([]);
  });

  it('TEST-API-COMPAT-001 条件式守卫：若声明 deprecated=true 必须提供合法 sunsetDate', () => {
    for (const route of deprecatedRoutes) {
      expect(route.sunsetDate, `${route.routeId} 缺少 sunsetDate`).toBeDefined();
      expect(isValidSunsetDate(route.sunsetDate), `${route.routeId} sunsetDate 非法`).toBe(true);
    }
    for (const entry of openApiOperations.filter((item) => item.operation.deprecated === true)) {
      expect(
        isValidSunsetDate(entry.operation.sunsetDate),
        `${entry.operation.operationId ?? entry.path} 缺少合法 sunsetDate`,
      ).toBe(true);
    }
  });

  it('ACC-API-002/ACC-API-006 supported 路由保持兼容：注册表与 OpenAPI operation 一致', () => {
    const operationIds = openApiOperations.map((entry) => entry.operation['x-kb-route-id']);
    expect(operationIds.filter((id) => typeof id !== 'string')).toEqual([]);
    expect(new Set(operationIds).size).toBe(87);

    const registered = new Set(operationIds);
    const missing = routes
      .filter((route) => !registered.has(route.routeId))
      .map((route) => route.routeId);
    expect(missing).toEqual([]);

    // 87 条 route 条目中 API-EXT-001 声明 GET/POST，因此 method+path operation 数为 88。
    const declaredOperations = new Set(
      ROUTE_REGISTRY.flatMap((route) =>
        routeMethods(route).map((method) => `${method} ${route.path}`),
      ),
    );
    expect(declaredOperations.size).toBe(88);
    const openApiKeys = new Set(
      openApiOperations.map((entry) => `${entry.method.toUpperCase()} ${entry.path}`),
    );
    expect(openApiKeys.size).toBe(88);
  });
});
