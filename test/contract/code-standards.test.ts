import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 编码规范验收 ACC-CODE-001…005 与 V7 索引声明（设计 18.14 / 19.8 / 22.6.1，任务 P8-01-S08）。
 * ACC-CODE-005 同时承载 ACC-TEST-004 的可执行部分（性能承诺措辞扫描）。
 */

const repoRoot = resolve(import.meta.dirname, '../..');
const serviceRoot = join(repoRoot, 'packages/service/src');
const schemasRoot = join(serviceRoot, 'shared/persistence/schemas');
const DEFINE_INDEX_FILE = join(serviceRoot, 'shared/persistence/define-index.ts');
const ARCHITECTURE_TEST_FILE = join(repoRoot, 'test/contract/architecture.test.ts');

const QUERY_CALL =
  /\.(?:find|findOne|findOneAndUpdate|updateOne|updateMany|deleteOne|deleteMany|aggregate|countDocuments)\s*\(/g;
const INFRA_IMPORT =
  /from\s+['"](?:mongoose|pg|ioredis|bullmq|minio|next|@aws-sdk\/[^'"]*|@opentelemetry\/[^'"]*|pino)(?:\/[^'"]*)?['"]/;
const THROW_NEW_ERROR = /throw\s+new\s+Error\s*\(/;
/** SLA/RPO/RTO/QPS 承诺词；允许设计 19.6 明确规定的规格数值（不含承诺词）。 */
const PROHIBITED_PROMISE = /\b(?:SLA|RPO|RTO|QPS)\b|\breq\/s\b|\brps\b/i;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function sourceRoots(): string[] {
  const roots = [join(repoRoot, 'projects/app/src')];
  for (const scope of ['packages', 'sdk']) {
    const base = join(repoRoot, scope);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(base, entry.name, 'src'));
    }
  }
  return roots.filter((root) => existsSync(root));
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function repositoryAdapterFiles(): string[] {
  return walk(serviceRoot).filter((file) => /\.(repository|adapter)\.ts$/.test(file));
}

function schemaDefinitionBody(code: string): string | null {
  const ctor = code.search(/new\s+Schema\s*</);
  if (ctor === -1) return null;
  const open = code.indexOf('{', code.indexOf('(', ctor));
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === '{') depth += 1;
    else if (code[index] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, index + 1);
    }
  }
  return null;
}

describe('编码规范验收（ACC-CODE-001…005 / ACC-TEST-004 可执行部分 / V7）', () => {
  it('ACC-CODE-001 业务层不直接依赖基础设施客户端，且既有架构测试保留该断言', () => {
    const modulesRoot = join(serviceRoot, 'modules');
    const violations = walk(modulesRoot)
      .filter((file) => relative(modulesRoot, file).split('/').includes('domain'))
      .filter((file) => INFRA_IMPORT.test(readFileSync(file, 'utf8')))
      .map((file) => relative(repoRoot, file));
    expect(violations).toEqual([]);
    expect(existsSync(ARCHITECTURE_TEST_FILE)).toBe(true);
    expect(readFileSync(ARCHITECTURE_TEST_FILE, 'utf8')).toContain('ACC-CODE-001');
  });

  it('ACC-CODE-002 所有错误经统一错误工厂：src 中不存在 throw new Error', () => {
    const violations = sourceRoots().flatMap((root) =>
      walk(root)
        .filter((file) => !/\.test\.tsx?$|\.spec\.tsx?$/.test(file))
        .filter((file) => THROW_NEW_ERROR.test(stripComments(readFileSync(file, 'utf8'))))
        .map((file) => relative(repoRoot, file)),
    );
    expect(violations).toEqual([]);
  });

  it('ACC-CODE-003 Repository/Adapter 查询带 teamId 或 tenantScopedModel 谓词', () => {
    const violations: string[] = [];
    for (const file of repositoryAdapterFiles()) {
      const code = readFileSync(file, 'utf8');
      const querySites = [...code.matchAll(QUERY_CALL)];
      if (querySites.length === 0) continue;
      if (/teamId|tenantScopedModel/.test(code)) continue;
      const lines = querySites
        .map((match) => code.slice(0, match.index).split('\n').length)
        .join(', ');
      violations.push(`${relative(repoRoot, file)}: 查询行 [${lines}] 缺少 teamId 谓词`);
    }
    expect(violations).toEqual([]);
    expect(repositoryAdapterFiles().length).toBeGreaterThan(0);
  });

  it('ACC-CODE-004 索引/迁移/OpenAPI/SBOM 门禁在 scripts 与 CI 中接线', () => {
    const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const script of [
      'architecture:check',
      'openapi:check',
      'forbidden-files:check',
      'license:check',
      'sbom:generate',
    ]) {
      expect(rootPackage.scripts[script], `scripts.${script}`).toBeDefined();
    }

    const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    for (const gate of [
      'pnpm architecture:check',
      'pnpm openapi:check',
      'pnpm forbidden-files:check',
      'pnpm license:check',
    ]) {
      expect(ci).toContain(gate);
    }
    // sbom:generate 入 CI 属 personB/P8-04 的等待项，本用例只登记 wiring，不据此判失败。
  });

  it('ACC-CODE-005 / ACC-TEST-004 可执行部分：代码与配置无统一 SLA/RPO/RTO/QPS 承诺', () => {
    const candidates = [
      ...sourceRoots().flatMap((root) => walk(root)),
      join(repoRoot, 'package.json'),
      join(repoRoot, 'turbo.json'),
      join(repoRoot, 'deploy/docker-compose.yml'),
      join(repoRoot, '.github/workflows/ci.yml'),
    ].filter((file) => existsSync(file));

    const violations = candidates
      .filter((file) => PROHIBITED_PROMISE.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(repoRoot, file));
    expect(violations).toEqual([]);

    const allowedDesignConstants =
      'pushData 200 条/10MB；rawText 10MiB；候选 100；权重 0.5；租约 10 分钟；TTL 7 天/360 天';
    expect(PROHIBITED_PROMISE.test(allowedDesignConstants)).toBe(false);
  });

  it('V7 索引声明：无字段级 index/unique，且无直接 schema.index() 调用', () => {
    const fieldViolations = readdirSync(schemasRoot)
      .filter((file) => file.endsWith('.ts'))
      .flatMap((file) => {
        const body = schemaDefinitionBody(readFileSync(join(schemasRoot, file), 'utf8'));
        if (body === null) return [];
        return /(?:^|[,{\s])(?:index|unique)\s*:\s*true/.test(body)
          ? [`${file}: schema 字段级别声明 index/unique`]
          : [];
      });
    expect(fieldViolations).toEqual([]);

    const directIndexCalls = walk(serviceRoot)
      .filter((file) => file !== DEFINE_INDEX_FILE)
      .filter((file) => /\.index\s*\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(repoRoot, file));
    expect(directIndexCalls).toEqual([]);
  });
});
