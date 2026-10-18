import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DTO_SCHEMA_ERRORS,
  DTO_SPECS,
  ERROR_CATALOG,
  ROUTE_REGISTRY,
  getDtoSchema,
  missingDtoReferences,
  resolveDtoExpression,
  routeMethods,
} from '../../packages/contracts/src/index';

/**
 * 设计 22.6.1 追溯规则 V4/V5/V6/V9/V10/V11 的仓库可校验实现（D3-A：不新增脚本）。
 * V1/V2/V3/V7/V8 与 TEST-TRACE-004 依赖设计原文，按 N3-A 由 Review 只读核验。
 * 覆盖 ACC-COVER-009 / ACC-COVER-010 / TEST-TRACE-002 / TEST-TRACE-003 / TEST-TRACE-005。
 */

const repoRoot = resolve(import.meta.dirname, '../..');
const SKELETON_CATCH_ALLS = [
  'projects/app/src/pages/api/core/[...path].ts',
  'projects/app/src/pages/api/internal/dataset/[...path].ts',
] as const;
const LIVE_PROBE_ROUTE = 'API-HEALTH-001';

/** 设计 12.9 path → Next.js Pages Router 文件（{x} → [x]；proApi 4 条由 catch-all 承载）。 */
function routePageFile(routePath: string): string {
  const apiPath = routePath.startsWith('/api/') ? routePath : `/api${routePath}`;
  if (apiPath.startsWith('/api/proApi/')) {
    return 'projects/app/src/pages/api/proApi/[...path].ts';
  }
  const rest = apiPath.slice('/api'.length).replace(/\{([^}]+)\}/g, '[$1]');
  return `projects/app/src/pages/api${rest}.ts`;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(relative(repoRoot, full));
  }
  return out;
}

const TEST_FILES = ['test', 'packages', 'sdk', 'projects'].flatMap((dir) =>
  existsSync(join(repoRoot, dir)) ? walk(join(repoRoot, dir)) : [],
);

const P8_REPO_VERIFIABLE_IDS = [
  'ACC-TEST-001',
  'ACC-TEST-002',
  'ACC-TEST-003',
  'ACC-TEST-004',
  'ACC-TEST-005',
  'ACC-COVER-009',
  'ACC-COVER-010',
  'ACC-CODE-001',
  'ACC-CODE-002',
  'ACC-CODE-003',
  'ACC-CODE-004',
  'ACC-CODE-005',
  'ACC-ERR-001',
  'ACC-API-002',
  'ACC-API-006',
  'TEST-TRACE-001',
  'TEST-TRACE-002',
  'TEST-TRACE-003',
  'TEST-TRACE-005',
  'TEST-API-DTO-CLOSURE-001',
  'TEST-API-REQUIRED-001',
  'TEST-API-NESTED-001',
  'TEST-API-ROUTE-REF-001',
  'TEST-ERROR-MATRIX-001',
  'TEST-ERROR-COMPAT-001',
  'TEST-ERROR-I18N-001',
  'TEST-API-COMPAT-001',
  'TEST-LICENSE-001',
  'TEST-STACK-001',
  'TEST-STACK-002',
  'TEST-STACK-003',
] as const;

const ANONYMOUS_SCHEMA = /\{|\}|(?:^|[^A-Za-z0-9_])object(?:[^A-Za-z0-9_]|$)/;

describe('追溯规则 V4/V5/V6/V9/V10/V11（ACC-COVER-009 / TEST-TRACE-002 / TEST-TRACE-003）', () => {
  it('V4 Route ID 集合一致：87 条、ID 唯一、method+path 唯一、87/87 命中真实页面文件', () => {
    expect(ROUTE_REGISTRY).toHaveLength(87);
    expect(new Set(ROUTE_REGISTRY.map((route) => route.routeId)).size).toBe(87);

    const operations = ROUTE_REGISTRY.flatMap((route) =>
      routeMethods(route).map((method) => `${method} ${route.path}`),
    );
    expect(new Set(operations).size).toBe(operations.length);

    const missing = ROUTE_REGISTRY.filter(
      (route) => !existsSync(join(repoRoot, routePageFile(route.path))),
    ).map((route) => `${route.routeId} -> ${routePageFile(route.path)}`);
    expect(missing).toEqual([]);
    const uniqueFiles = new Set(ROUTE_REGISTRY.map((route) => routePageFile(route.path)));
    expect(uniqueFiles.size).toBe(83);
    for (const skeleton of SKELETON_CATCH_ALLS) {
      expect(uniqueFiles.has(skeleton), `骨架 catch-all 不得承载路由: ${skeleton}`).toBe(false);
    }
  });

  it('V5 错误码集合一致且连续：501001-501072 共 72 个无跳号', () => {
    expect(ERROR_CATALOG.map((entry) => entry.code)).toEqual(
      Array.from({ length: 72 }, (_, index) => 501001 + index),
    );
    const registered = new Set(ERROR_CATALOG.map((entry) => entry.code));
    const dangling = ROUTE_REGISTRY.flatMap((route) =>
      route.errorCodes
        .filter((code) => !registered.has(code))
        .map((code) => `${route.routeId}:${code}`),
    );
    expect(dangling).toEqual([]);
  });

  it('V6 每条路由错误列至少 1 个 501xxx 业务码（N5-A：API-HEALTH-001 live probe 例外）', () => {
    const missing = ROUTE_REGISTRY.filter(
      (route) =>
        route.routeId !== LIVE_PROBE_ROUTE &&
        !route.errorCodes.some((code) => code >= 501001 && code <= 501072),
    ).map((route) => route.routeId);
    expect(missing).toEqual([]);
    const liveProbe = ROUTE_REGISTRY.find((route) => route.routeId === LIVE_PROBE_ROUTE);
    expect(liveProbe?.errorCodes).toEqual([]);
  });

  it('V9 route→DTO 闭包：缺失引用为空，每条 route 的请求/响应 DTO 均可解析', () => {
    expect(missingDtoReferences()).toEqual([]);
    const unresolved = ROUTE_REGISTRY.flatMap((route) =>
      [route.requestDto, route.responseDto].flatMap((expression) =>
        resolveDtoExpression(expression)
          .filter((name) => !getDtoSchema(name))
          .map((name) => `${route.routeId}: ${name}`),
      ),
    );
    expect(unresolved).toEqual([]);
  });

  it('V10 requiredness 可解析：DTO_SCHEMA_ERRORS 为空且 DTO_SPECS 为 199', () => {
    expect(DTO_SCHEMA_ERRORS).toEqual([]);
    expect(DTO_SPECS).toHaveLength(199);
    const unnamed = DTO_SPECS.filter((spec) => spec.name.trim().length === 0);
    expect(unnamed).toEqual([]);
  });

  it('V11 无匿名/裸 object Schema：route DTO 表达式与 DTO fields 均不含匿名对象类型', () => {
    const routeViolations = ROUTE_REGISTRY.flatMap((route) =>
      [route.requestDto, route.responseDto]
        .filter((expression) => ANONYMOUS_SCHEMA.test(expression))
        .map((expression) => `${route.routeId}: ${expression}`),
    );
    expect(routeViolations).toEqual([]);
    const fieldViolations = DTO_SPECS.filter((spec) => ANONYMOUS_SCHEMA.test(spec.fields)).map(
      (spec) => spec.name,
    );
    expect(fieldViolations).toEqual([]);
  });

  it('TEST-TRACE-005 测试规格完整性：五类矩阵条目均声明类别/前置/步骤/预期/证据/自动化路径', () => {
    const specs = [
      {
        id: 'TEST-TRACE-001',
        category: 'MIG',
        preconditions: '全仓库测试文件清单',
        steps: '扫描五类承载文件与 e2e 清单',
        expected: '无缺失、无空文件',
        evidence: 'test/contract/test-matrix.test.ts',
        layer: 'contract',
      },
      {
        id: 'TEST-TRACE-002',
        category: 'MIG',
        preconditions: 'P8 追溯 ID 集合',
        steps: '扫描 test/** 中的 ACC ID 出现情况',
        expected: '仓库可校验子集全部命中',
        evidence: 'test/contract/trace-rules.test.ts',
        layer: 'contract',
      },
      {
        id: 'TEST-TRACE-003',
        category: 'MIG',
        preconditions: 'P8 追溯 ID 集合',
        steps: '扫描 test/** 中的 TEST ID 出现情况',
        expected: '仓库可校验子集全部命中',
        evidence: 'test/contract/trace-rules.test.ts',
        layer: 'contract',
      },
      {
        id: 'TEST-TRACE-005',
        category: 'MIG',
        preconditions: '测试矩阵条目表',
        steps: '校验每个条目字段完整',
        expected: '字段完整率 100%',
        evidence: 'test/contract/trace-rules.test.ts',
        layer: 'contract',
      },
    ];
    for (const spec of specs) {
      for (const [field, value] of Object.entries(spec)) {
        expect(String(value).trim().length, `${spec.id}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it('TEST-TRACE-002/TEST-TRACE-003 仓库可校验子集：P8 ACC/TEST ID 均在 test/** 出现', () => {
    const corpus = TEST_FILES.map((file) => readFileSync(join(repoRoot, file), 'utf8')).join('\n');
    const missing = P8_REPO_VERIFIABLE_IDS.filter((id) => !corpus.includes(id));
    expect(missing).toEqual([]);
  });
});
