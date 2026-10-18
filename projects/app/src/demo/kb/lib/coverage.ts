import type { RouteEntry, RunEntry } from '../types';
import { DEMO_ROUTES } from './route-list.generated';

export type CoverageStatus = 'passed' | 'failed' | 'untested' | 'not-applicable';

export interface RouteCoverage {
  route: RouteEntry;
  status: CoverageStatus;
  lastRun?: RunEntry;
  note?: string;
}

const compiled = DEMO_ROUTES.map((route) => ({
  route,
  regex: toRegex(route.path),
  methods: route.method.split('/').map((method) => method.trim().toUpperCase()),
}));

function toRegex(pattern: string): RegExp {
  let source = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === '*' ? '*' : `\\${char}`))
    .replace(/\\\{[^}]+\\\}/g, '[^/]+')
    .replace(/\*\*/g, '.+');
  // 未转义的花括号参数（第一次替换可能未覆盖）
  source = source.replace(/\{[^}]+\}/g, '[^/]+');
  return new RegExp(`^${source}/?$`);
}

export function normalizePath(raw: string): string {
  try {
    const url = new URL(raw, 'http://demo.local');
    return url.pathname;
  } catch {
    return raw.split('?')[0] ?? raw;
  }
}

/** 找到某次调用对应的注册路由（用于覆盖矩阵与缺陷定位）。 */
export function matchRoute(entry: Pick<RunEntry, 'method' | 'path'>): RouteEntry | undefined {
  const pathname = normalizePath(entry.path);
  const method = entry.method.toUpperCase();
  return compiled.find(
    (item) => item.methods.includes(method) && item.regex.test(pathname),
  )?.route;
}

function applicability(route: RouteEntry): { status: CoverageStatus; note?: string } | null {
  if (!route.implemented) return { status: 'not-applicable', note: '注册表标记未实现' };
  if (route.group === 'admin' || /root/i.test(route.source)) {
    return { status: 'not-applicable', note: '需要 Root 身份（开发态固定身份无法触发）' };
  }
  return null;
}

/** 依据本次会话的调用记录计算 87 条路由的触达情况。 */
export function computeCoverage(runs: readonly RunEntry[]): RouteCoverage[] {
  const lastByRoute = new Map<string, RunEntry>();
  for (const run of runs) {
    const route = matchRoute(run);
    if (!route) continue;
    const current = lastByRoute.get(route.routeId);
    if (!current || run.seq > current.seq) lastByRoute.set(route.routeId, run);
  }

  return DEMO_ROUTES.map((route) => {
    const special = applicability(route);
    const lastRun = lastByRoute.get(route.routeId);
    if (special) {
      return { route, status: special.status, ...(lastRun ? { lastRun } : {}), ...(special.note ? { note: special.note } : {}) };
    }
    if (!lastRun) return { route, status: 'untested' as const };
    const ok = lastRun.status >= 200 && lastRun.status < 300 && lastRun.code === 200;
    return { route, status: ok ? ('passed' as const) : ('failed' as const), lastRun };
  });
}

export function coverageSummary(rows: readonly RouteCoverage[]): {
  total: number;
  passed: number;
  failed: number;
  untested: number;
  notApplicable: number;
} {
  const count = (status: CoverageStatus) => rows.filter((row) => row.status === status).length;
  return {
    total: rows.length,
    passed: count('passed'),
    failed: count('failed'),
    untested: count('untested'),
    notApplicable: count('not-applicable'),
  };
}

export function groupRoutes(rows: readonly RouteCoverage[]): Map<string, RouteCoverage[]> {
  const map = new Map<string, RouteCoverage[]>();
  for (const row of rows) {
    const key = familyOf(row.route);
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

export function familyOf(route: RouteEntry): string {
  const match = /^API-([A-Z]+)-/.exec(route.routeId);
  if (match?.[1]) return match[1];
  return route.group.toUpperCase();
}
