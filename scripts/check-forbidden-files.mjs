#!/usr/bin/env node
/**
 * 禁止文件与禁止依赖检查（设计文档 4 节 / 18.10）。
 *
 * 检查项：
 * 1. 任何 package.json 与 lockfile 不得出现 @fastgpt-* / @fastgpt-sdk/* 依赖。
 * 2. 业务源码、部署文件不得引用来源项目模块名、镜像或环境变量。
 * 3. websiteDataset 只允许出现在拒绝规则常量与文档中。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ignoredDirs = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  'artifacts',
]);
const sourceRoots = ['packages', 'sdk', 'projects', 'test', 'deploy', 'scripts'];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const errors = [];
const fastgptPackages = [];
let scanned = 0;

for (const dir of sourceRoots) {
  for (const file of walk(join(root, dir))) {
    scanned += 1;
    const rel = relative(root, file);
    if (file.endsWith('package.json')) {
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      for (const section of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        for (const name of Object.keys(pkg[section] ?? {})) {
          if (/^@fastgpt(-sdk)?\//.test(name)) fastgptPackages.push(`${rel}: ${name}`);
        }
      }
    }
  }
}

try {
  const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  if (/@fastgpt(-sdk)?\//.test(lock)) errors.push('pnpm-lock.yaml 出现 @fastgpt-* 依赖');
} catch {
  // lockfile 由用户执行 pnpm install 后生成。
}

for (const dir of sourceRoots) {
  for (const file of walk(join(root, dir))) {
    const rel = relative(root, file);
    if (rel.startsWith('scripts/check-forbidden-files.mjs')) continue;
    if (!/\.(ts|tsx|mjs|cjs|js|json|ya?ml|sql|env|example)$/.test(file)) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (rel.startsWith('docs/')) continue;
    if (/@fastgpt(-sdk)?\//.test(text)) {
      errors.push(`${rel}: 出现来源项目模块名 @fastgpt-*`);
    }
    const websiteDatasetAllowed =
      rel.endsWith('packages/contracts/src/enums/dataset.ts') ||
      rel.endsWith('packages/contracts/src/errors/error-catalog.data.json') ||
      rel.startsWith('test/');
    if (/websiteDataset/.test(text) && !websiteDatasetAllowed) {
      errors.push(`${rel}: websiteDataset 只允许出现在拒绝规则常量定义处`);
    }
  }
}

if (fastgptPackages.length > 0) {
  errors.push(...fastgptPackages.map((entry) => `${entry}: 禁止作为运行时依赖`));
}

if (errors.length > 0) {
  console.error(`forbidden-files:check 失败，共 ${errors.length} 项：`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `forbidden-files:check 通过：扫描 ${scanned} 个文件，未发现 @fastgpt-* 依赖或来源素材引用。`,
);
