import deferredData from './deferred-manifest.data.json';
import fullData from './route-registry.data.json';
import runtimeData from './runtime-registry.data.json';

export type OperationGroup =
  | 'system'
  | 'space'
  | 'directory'
  | 'source'
  | 'segment'
  | 'tag'
  | 'access'
  | 'job'
  | 'import'
  | 'connector'
  | 'upload'
  | 'file'
  | 'search'
  | 'citation'
  | 'model'
  | 'api-key'
  | 'usage'
  | 'audit'
  | 'operations'
  | 'synonym';

export type PlannedStage = 'BASE' | 'F1' | 'F2' | 'F3' | 'F4' | 'F5';

export interface RouteEntry {
  operationId: string;
  method: string;
  path: string;
  group: OperationGroup;
  requestSchema: string | null;
  responseSchema: string | null;
  scopes: string[];
  idempotent: boolean;
  rateLimit: string | null;
  timeoutMs: number | null;
  audit: boolean;
  downstreamAllowed: boolean;
  runtime: boolean;
  stage: PlannedStage;
  targetSection: string;
  accId: string | null;
  capabilityIds: string[];
}

export interface DeferredRouteEntry extends RouteEntry {
  runtime: false;
  reason: 'OUT_OF_ARCHITECTURE_BASELINE_RUNTIME_SCOPE';
}

export interface RouteMatch {
  route: RouteEntry;
  params: Readonly<Record<string, string>>;
}

export const TARGET_CONTRACT_COUNTS = fullData.counts;
export const FULL_ROUTE_REGISTRY = fullData.routes as unknown as readonly RouteEntry[];
export const RUNTIME_ROUTE_REGISTRY = runtimeData.operations as unknown as readonly RouteEntry[];
export const DEFERRED_OPERATION_MANIFEST =
  deferredData.operations as unknown as readonly DeferredRouteEntry[];

export const FULL_ROUTE_REGISTRY_BY_ID: ReadonlyMap<string, RouteEntry> = new Map(
  FULL_ROUTE_REGISTRY.map((route) => [route.operationId, route]),
);

export const RUNTIME_ROUTE_REGISTRY_BY_ID: ReadonlyMap<string, RouteEntry> = new Map(
  RUNTIME_ROUTE_REGISTRY.map((route) => [route.operationId, route]),
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileRoutePath(path: string): RegExp {
  let expression = '';
  let cursor = 0;
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    const index = match.index ?? 0;
    expression += escapeRegExp(path.slice(cursor, index));
    expression += '([^/]+)';
    cursor = index + match[0].length;
  }
  expression += escapeRegExp(path.slice(cursor));
  return new RegExp(`^${expression}$`);
}

const RUNTIME_MATCHERS = RUNTIME_ROUTE_REGISTRY.map((route) => ({
  route,
  matcher: compileRoutePath(route.path),
  params: [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string),
}));

export function matchRuntimeRoute(
  method: string | undefined,
  rawPath: string,
): RouteMatch | undefined {
  const pathname = rawPath.split('?')[0] ?? rawPath;
  const normalizedMethod = (method ?? 'GET').toUpperCase();
  for (const candidate of RUNTIME_MATCHERS) {
    if (candidate.route.method !== normalizedMethod) continue;
    const match = candidate.matcher.exec(pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    candidate.params.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1] ?? '');
    });
    return { route: candidate.route, params };
  }
  return undefined;
}

export function validateRouteRegistry(): string[] {
  const problems: string[] = [];
  if (FULL_ROUTE_REGISTRY.length !== 120) {
    problems.push(`完整 registry 应为 120，实际 ${FULL_ROUTE_REGISTRY.length}`);
  }
  if (RUNTIME_ROUTE_REGISTRY.length !== 65) {
    problems.push(`runtime registry 应为 65，实际 ${RUNTIME_ROUTE_REGISTRY.length}`);
  }
  if (DEFERRED_OPERATION_MANIFEST.length !== 55) {
    problems.push(`deferred manifest 应为 55，实际 ${DEFERRED_OPERATION_MANIFEST.length}`);
  }

  const fullIds = new Set(FULL_ROUTE_REGISTRY.map((route) => route.operationId));
  const runtimeIds = new Set(RUNTIME_ROUTE_REGISTRY.map((route) => route.operationId));
  const deferredIds = new Set(DEFERRED_OPERATION_MANIFEST.map((route) => route.operationId));
  if (fullIds.size !== FULL_ROUTE_REGISTRY.length)
    problems.push('完整 registry 存在重复 operationId');
  if (runtimeIds.size !== RUNTIME_ROUTE_REGISTRY.length)
    problems.push('runtime registry 存在重复 operationId');
  if (deferredIds.size !== DEFERRED_OPERATION_MANIFEST.length) {
    problems.push('deferred manifest 存在重复 operationId');
  }
  for (const operationId of runtimeIds) {
    if (deferredIds.has(operationId)) problems.push(`runtime/deferred 交集: ${operationId}`);
    if (!fullIds.has(operationId)) problems.push(`runtime 缺少完整合同 operation: ${operationId}`);
  }
  for (const operationId of deferredIds) {
    if (!fullIds.has(operationId)) problems.push(`deferred 缺少完整合同 operation: ${operationId}`);
  }
  if (runtimeIds.size + deferredIds.size !== fullIds.size) {
    problems.push('runtime 与 deferred 并未完整覆盖目标合同');
  }
  for (const route of DEFERRED_OPERATION_MANIFEST) {
    if (route.runtime) problems.push(`deferred manifest 误标 runtime: ${route.operationId}`);
    if (!route.stage) problems.push(`deferred 缺少计划阶段: ${route.operationId}`);
    if (!route.accId) problems.push(`deferred 缺少 ACC ID: ${route.operationId}`);
    if (route.targetSection !== '9.2') {
      problems.push(`deferred 缺少目标设计章节: ${route.operationId}`);
    }
  }
  return problems;
}
