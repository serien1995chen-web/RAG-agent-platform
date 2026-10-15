import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P8-01 测试矩阵断言（设计 19.1-19.4.4 / 任务拆解 P8-01）。
 *
 * 覆盖 ACC-TEST-001（五类必测非空）、ACC-TEST-002（关键设计至少映射一个测试）、
 * ACC-TEST-003（失败/重复/并发/恢复/对账路径有实测承载）、TEST-TRACE-001。
 * 计数与用例清单来自 2026-10-15 对基线 858013f 的只读盘点。
 */

const repoRoot = resolve(import.meta.dirname, '../..');

function readRepoFile(relativePath: string): string {
  const fullPath = join(repoRoot, relativePath);
  return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : '';
}

/** 统计 it(...) / test(...) 用例数；it.each / test.skip 等修饰形式不计入。 */
function countCases(relativePath: string): number {
  const matches = readRepoFile(relativePath).match(/(?:^|[^A-Za-z0-9_$.])(?:it|test)\s*\(/g);
  return matches?.length ?? 0;
}

function collectCarrierFailures(files: readonly string[]): string[] {
  return files.flatMap((file) => {
    if (!existsSync(join(repoRoot, file))) return [`${file}: 文件不存在`];
    return countCases(file) > 0 ? [] : [`${file}: 无 it/test 用例`];
  });
}

const FI_FILES = [
  'test/fault/fault-injection.test.ts',
  'test/fault/link-ssrf.test.ts',
  'test/fault/search-rerank.test.ts',
  'test/fault/search-degrade.test.ts',
  'test/fault/ttl-failure.test.ts',
  'test/fault/delete-fault.test.ts',
  'test/fault/otel-failure.test.ts',
  'test/fault/ingest-fault.test.ts',
] as const;

const REP_FILES = [
  'test/concurrency/concurrency.test.ts',
  'test/e2e/data-write.test.ts',
  'test/e2e/delete-jobs.test.ts',
  'packages/dal/test/unit/idempotency.test.ts',
  'packages/dal/test/integration/redis-idempotency.test.ts',
] as const;

const TEN_FILES = [
  'test/tenant/tenant-guards.test.ts',
  'test/tenant/search-tenant.test.ts',
  'test/tenant/ingest-tenant.test.ts',
  'test/tenant/admin-tenant.test.ts',
  'packages/service/test/integration/tenant-scoped-repository.test.ts',
  'test/e2e/data-read-acl.test.ts',
] as const;

const MIG_FILES = [
  'test/e2e/migration.test.ts',
  'test/e2e/migration-ops.test.ts',
  'packages/service/test/integration/migration-executor.test.ts',
  'packages/service/test/integration/migration-repository.test.ts',
] as const;

const RECON_FILES = [
  'packages/service/test/integration/reconcile.test.ts',
  'packages/service/test/integration/compensation.test.ts',
  'packages/service/test/integration/s3-ttl.test.ts',
  'test/fault/ttl-failure.test.ts',
  'test/e2e/delete-e2e.test.ts',
] as const;

const CATEGORY_MATRIX = [
  { category: 'FI', label: '故障注入', files: FI_FILES },
  { category: 'REP', label: '重复请求', files: REP_FILES },
  { category: 'TEN', label: '跨租户访问', files: TEN_FILES },
  { category: 'MIG', label: '迁移恢复', files: MIG_FILES },
  { category: 'RECON', label: '对账', files: RECON_FILES },
] as const;

/** 关键设计 → 仓库内可执行测试文件（ACC-TEST-002；设计原文依赖项由 Review 只读核验）。 */
const KEY_DESIGN_TESTS = [
  { design: '19.2 FI 故障注入与补偿', file: 'test/fault/fault-injection.test.ts' },
  { design: '19.2 REP 重复请求与幂等', file: 'packages/dal/test/unit/idempotency.test.ts' },
  { design: '19.2 TEN 跨租户隔离', file: 'test/tenant/tenant-guards.test.ts' },
  { design: '19.2 MIG 迁移恢复', file: 'test/e2e/migration.test.ts' },
  { design: '19.2 RECON 对账与补偿', file: 'packages/service/test/integration/reconcile.test.ts' },
  { design: '12.8/12.9 契约与 OpenAPI 元数据', file: 'test/contract/contracts.test.ts' },
  { design: '5.7/18.2 分层架构边界', file: 'test/contract/architecture.test.ts' },
  { design: '6.6-6.9 启动配置与依赖基线', file: 'test/contract/startup-config.test.ts' },
  { design: '18.3 请求与业务上限', file: 'test/contract/limits.test.ts' },
  { design: '17.x 观测、审计与脱敏', file: 'test/contract/observability.test.ts' },
  { design: '9.x 解析格式矩阵', file: 'packages/parse/test/unit/format-matrix.test.ts' },
  { design: '13.x 检索融合与权重', file: 'packages/search/test/unit/rrf.test.ts' },
  { design: '8.x 图片流水线', file: 'test/e2e/image-pipeline.test.ts' },
  { design: '15.x 删除与对账链路', file: 'test/e2e/delete-e2e.test.ts' },
  { design: '10.x 索引写入一致性', file: 'packages/service/test/integration/index-write.test.ts' },
  { design: '14.x 链接 SSRF 与读取限制', file: 'test/fault/link-ssrf.test.ts' },
] as const;

/** e2e 逐文件非空清单：21 文件 / 113 用例（test:e2e 带 --passWithNoTests，必须非空）。 */
const E2E_CASES = [
  ['test/e2e/admin-security.test.ts', 5],
  ['test/e2e/collection-create.test.ts', 11],
  ['test/e2e/collection-management.test.ts', 1],
  ['test/e2e/data-read-acl.test.ts', 1],
  ['test/e2e/data-write.test.ts', 6],
  ['test/e2e/dataset-management.test.ts', 1],
  ['test/e2e/delete-e2e.test.ts', 4],
  ['test/e2e/delete-jobs.test.ts', 8],
  ['test/e2e/e2e.test.ts', 2],
  ['test/e2e/file-upload.test.ts', 8],
  ['test/e2e/image-pipeline.test.ts', 2],
  ['test/e2e/import-export.test.ts', 11],
  ['test/e2e/ingest-full-chain.test.ts', 2],
  ['test/e2e/migration-ops.test.ts', 5],
  ['test/e2e/migration.test.ts', 5],
  ['test/e2e/pro-api.test.ts', 9],
  ['test/e2e/rebuild-retrain.test.ts', 10],
  ['test/e2e/search-e2e.test.ts', 4],
  ['test/e2e/search-index.test.ts', 9],
  ['test/e2e/sync-scheduler.test.ts', 6],
  ['test/e2e/training.test.ts', 3],
] as const;

describe('P8-01 必测五类承载矩阵（ACC-TEST-001 / ACC-TEST-002 / ACC-TEST-003 / TEST-TRACE-001）', () => {
  for (const entry of CATEGORY_MATRIX) {
    it(`ACC-TEST-001 ${entry.category} ${entry.label}至少有 1 个非空自动化承载文件`, () => {
      expect(entry.files.length).toBeGreaterThan(0);
      expect(collectCarrierFailures(entry.files)).toEqual([]);
    });
  }

  it('ACC-TEST-002 关键设计至少映射一个仓库内可执行测试文件', () => {
    expect(KEY_DESIGN_TESTS.length).toBeGreaterThanOrEqual(16);
    const failures = collectCarrierFailures(KEY_DESIGN_TESTS.map((entry) => entry.file));
    expect(failures).toEqual([]);
    const designs = new Set(KEY_DESIGN_TESTS.map((entry) => entry.design));
    expect(designs.size).toBe(KEY_DESIGN_TESTS.length);
  });

  it('ACC-TEST-003 失败/重复/并发/恢复/对账路径均有非空用例承载（TEST-TRACE-001）', () => {
    const evidenceGroups = [
      { path: '失败与降级', files: FI_FILES },
      { path: '重复请求', files: REP_FILES },
      { path: '并发与领取', files: ['test/concurrency/concurrency.test.ts'] as const },
      { path: '恢复与迁移', files: MIG_FILES },
      { path: '对账', files: RECON_FILES },
    ];
    for (const group of evidenceGroups) {
      expect(group.files.length, group.path).toBeGreaterThan(0);
      expect(collectCarrierFailures(group.files), group.path).toEqual([]);
    }
  });
});

describe('P8-01 e2e 非空清单（ACC-TEST-003 / TEST-TRACE-001）', () => {
  it('21 个 e2e 文件全部存在且逐文件非空', () => {
    expect(E2E_CASES).toHaveLength(21);
    const failures = E2E_CASES.flatMap(([file]) => {
      if (!existsSync(join(repoRoot, file))) return [`${file}: 文件不存在`];
      return countCases(file) > 0 ? [] : [`${file}: 无 it/test 用例`];
    });
    expect(failures).toEqual([]);
  });

  it('e2e 用例总数为 113，逐文件计数与盘点一致（不得以 --passWithNoTests 空跑冒充）', () => {
    const actual = E2E_CASES.map(([file]) => `${file}:${countCases(file)}`);
    const expected = E2E_CASES.map(([file, count]) => `${file}:${count}`);
    expect(actual).toEqual(expected);
    const total = E2E_CASES.reduce((sum, [, count]) => sum + count, 0);
    expect(total).toBe(113);
  });
});
