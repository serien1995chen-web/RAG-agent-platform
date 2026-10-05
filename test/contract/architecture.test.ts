import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');
const serviceRoot = join(repoRoot, 'packages', 'service', 'src');
const modulesRoot = join(serviceRoot, 'modules');

const MODULE_NAMES = [
  'knowledge-base',
  'collection',
  'item',
  'index',
  'processing',
  'permission',
  'delete',
  'migration',
] as const;
const LAYER_NAMES = ['domain', 'application', 'repository', 'adapter', 'jobs'] as const;

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

describe('服务分层架构（ACC-ARCH-001 / ACC-CODE-001）', () => {
  it('8 个模块各具备 domain/application/repository/adapter/jobs 五层', () => {
    for (const moduleName of MODULE_NAMES) {
      for (const layer of LAYER_NAMES) {
        const target = join(modulesRoot, moduleName, layer, 'index.ts');
        expect(existsSync(target), `${moduleName}/${layer}`).toBe(true);
      }
    }
  });

  it('domain 层不导入任何基础设施客户端', () => {
    const infraImport =
      /from\s+['"](mongoose|pg|ioredis|bullmq|minio|next|@aws-sdk|@opentelemetry|pino)([/'"]|$)/;
    const violations: string[] = [];
    for (const file of walk(modulesRoot)) {
      const segments = relative(serviceRoot, file).split('/');
      if (!segments.includes('domain')) continue;
      if (infraImport.test(readFileSync(file, 'utf8'))) {
        violations.push(relative(serviceRoot, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it('application 层不直接导入 repository/adapter/jobs 具体实现', () => {
    const violations: string[] = [];
    for (const file of walk(modulesRoot)) {
      const segments = relative(serviceRoot, file).split('/');
      if (!segments.includes('application')) continue;
      const code = readFileSync(file, 'utf8');
      if (/from\s+['"][^'"]*\/(repository|adapter|jobs)\//.test(code)) {
        violations.push(relative(serviceRoot, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it('模块之间不存在跨模块内部导入', () => {
    const violations: string[] = [];
    for (const moduleName of MODULE_NAMES) {
      for (const file of walk(join(modulesRoot, moduleName))) {
        const code = readFileSync(file, 'utf8');
        for (const match of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
          const specifier = match[1];
          if (!specifier?.startsWith('.')) continue;
          const target = relative(modulesRoot, resolve(dirname(file), specifier));
          if (target.startsWith('..')) continue;
          const targetModule = target.split('/')[0];
          if (targetModule !== moduleName) {
            violations.push(`${relative(serviceRoot, file)} -> ${specifier}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
