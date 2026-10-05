import { ROUTE_REGISTRY, routeMethods, type RouteEntry } from '@kb/contracts';

export function normalizePath(url: string | undefined): string {
  const value = url ?? '/';
  const queryIndex = value.indexOf('?');
  return queryIndex === -1 ? value : value.slice(0, queryIndex);
}

function matchTemplate(pattern: string, actual: string): boolean {
  const patternParts = pattern.split('/');
  const actualParts = actual.split('/');
  if (patternParts.length !== actualParts.length) return false;
  return patternParts.every((part, index) => {
    const actualPart = actualParts[index];
    if (part.startsWith('{') && part.endsWith('}')) return Boolean(actualPart);
    return part === actualPart;
  });
}

/** 按 12.9 注册表匹配 Route ID；未登记路径返回 null，由调用方给出稳定未实现错误。 */
export function matchRoute(method: string | undefined, url: string | undefined): RouteEntry | null {
  const path = normalizePath(url);
  const upperMethod = (method ?? 'GET').toUpperCase();
  const candidates = ROUTE_REGISTRY.filter((route) => routeMethods(route).includes(upperMethod));

  // 具体路由优先于扩展 catch-all（API-EXT-001 覆盖 /proApi/**）。
  for (const route of candidates) {
    if (route.path.endsWith('/**')) continue;
    if (matchTemplate(route.path, path)) return route;
  }
  for (const route of candidates) {
    if (!route.path.endsWith('/**')) continue;
    const base = route.path.slice(0, -3);
    if (path === base || path.startsWith(`${base}/`)) return route;
  }
  return null;
}
