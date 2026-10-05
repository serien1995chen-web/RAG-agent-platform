import rawRegistry from './route-registry.data.json';
import { getErrorMeta } from '../errors/error-catalog';
import { getDtoSchema, resolveDtoExpression } from '../dataset/registry';

export interface RouteEntry {
  routeId: string;
  method: string;
  path: string;
  group: 'core' | 'admin' | 'internal' | 'extension' | 'health';
  requestDto: string;
  responseDto: string;
  errorCodes: number[];
  implemented: boolean;
  source: string;
}

/** 设计文档 12.9 共登记 87 条路由（53 + 31 + 3）。 */
export const ROUTE_REGISTRY: readonly RouteEntry[] =
  rawRegistry.routes as unknown as readonly RouteEntry[];

export const ROUTE_REGISTRY_BY_ID: ReadonlyMap<string, RouteEntry> = new Map(
  ROUTE_REGISTRY.map((route) => [route.routeId, route]),
);

export function routeMethods(route: RouteEntry): string[] {
  return route.method.split('/').map((method) => method.trim().toUpperCase());
}

/** 路由契约门禁：数量、唯一性、DTO 闭包、错误码登记、未实现语义。 */
export function validateRouteRegistry(): string[] {
  const errors: string[] = [];
  if (ROUTE_REGISTRY.length !== 87) {
    errors.push(`路由数量应为 87，实际 ${ROUTE_REGISTRY.length}`);
  }

  const seenIds = new Set<string>();
  const seenOperations = new Set<string>();
  for (const route of ROUTE_REGISTRY) {
    if (seenIds.has(route.routeId)) errors.push(`重复 Route ID: ${route.routeId}`);
    seenIds.add(route.routeId);

    for (const method of routeMethods(route)) {
      const operation = `${method} ${route.path}`;
      if (seenOperations.has(operation)) errors.push(`重复 method+path: ${operation}`);
      seenOperations.add(operation);
    }

    for (const expression of [route.requestDto, route.responseDto]) {
      for (const dtoName of resolveDtoExpression(expression)) {
        if (!getDtoSchema(dtoName)) {
          errors.push(`${route.routeId}: DTO 未登记 "${dtoName}"`);
        }
      }
    }

    for (const code of route.errorCodes) {
      if (!getErrorMeta(code)) errors.push(`${route.routeId}: 错误码未登记 ${code}`);
    }

    if (!route.implemented && route.errorCodes.length === 0 && route.routeId !== 'API-HEALTH-001') {
      errors.push(`${route.routeId}: 未实现路由必须声明稳定错误码`);
    }
  }

  return errors;
}
