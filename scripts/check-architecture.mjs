#!/usr/bin/env node
/**
 * 分层依赖方向检查（设计文档 5.7 / 7.2 / 18.2）。
 *
 * 检查项：
 * 1. domain 层不得导入基础设施客户端。
 * 2. application 层不得导入基础设施客户端或 repository/adapter/jobs 具体实现。
 * 3. 模块之间不得直接导入对方内部文件（Port 与 shared 允许）。
 * 4. packages/service/src 内相对导入不得形成循环依赖。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const serviceRoot = join(root, 'packages', 'service', 'src');
const modulesRoot = join(serviceRoot, 'modules');

const infraModules = new Set([
  'mongoose',
  'pg',
  'ioredis',
  'bullmq',
  'minio',
  'next',
  '@aws-sdk',
  '@opentelemetry',
  'pino',
]);

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function extractImports(code) {
  const specs = new Set();
  const staticImport = /(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]/g;
  const sideEffectImport = /import\s*['"]([^'"]+)['"]/g;
  const dynamicImport = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const regex of [staticImport, sideEffectImport, dynamicImport]) {
    let match;
    while ((match = regex.exec(code)) !== null) {
      specs.add(match[1]);
    }
  }
  return [...specs];
}

function isInfrastructure(spec) {
  const head = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  return infraModules.has(head);
}

function moduleOf(file) {
  const rel = relative(modulesRoot, file);
  if (rel.startsWith('..')) return null;
  const [name] = rel.split(/[\\/]/);
  return name ?? null;
}

function layerOf(file) {
  const rel = relative(modulesRoot, file);
  const parts = rel.split(/[\\/]/);
  return parts[1] ?? null;
}

const errors = [];
const files = walk(serviceRoot);
const graph = new Map();

for (const file of files) {
  const code = readFileSync(file, 'utf8');
  const imports = extractImports(code);
  const currentModule = moduleOf(file);
  const layer = layerOf(file);
  const relFile = relative(root, file);
  const localDeps = [];

  for (const spec of imports) {
    if (isInfrastructure(spec) && (layer === 'domain' || layer === 'application')) {
      errors.push(`${relFile}: ${layer} 层禁止导入基础设施模块 "${spec}"`);
    }

    if (layer === 'application' && /(^|\/)(repository|adapter|jobs)\//.test(spec)) {
      errors.push(`${relFile}: application 层禁止导入具体实现 "${spec}"（必须依赖 Port）`);
    }

    if (spec.startsWith('.')) {
      const resolved = resolve(dirname(file), spec);
      localDeps.push(resolved);
      const targetModule = moduleOf(resolved);
      if (currentModule !== null && targetModule !== null && targetModule !== currentModule) {
        errors.push(`${relFile}: 跨模块直接导入 "${spec}"（应通过 Port 或公开导出）`);
      }
    }
  }

  graph.set(file, localDeps);
}

// 循环依赖检测（只统计 packages/service/src 内部的相对导入）。
const state = new Map();
function visit(file, trail) {
  const status = state.get(file);
  if (status === 'done') return;
  if (status === 'visiting') {
    const cycle = [...trail.slice(trail.indexOf(file)), file]
      .map((item) => relative(root, item))
      .join(' -> ');
    errors.push(`检测到循环依赖: ${cycle}`);
    return;
  }
  state.set(file, 'visiting');
  for (const dep of graph.get(file) ?? []) {
    const candidates = [dep, `${dep}.ts`, `${dep}.tsx`, join(dep, 'index.ts')];
    for (const candidate of candidates) {
      try {
        if (statSync(candidate).isFile()) {
          visit(candidate, [...trail, file]);
          break;
        }
      } catch {
        // 忽略不存在候选路径。
      }
    }
  }
  state.set(file, 'done');
}

for (const file of files) {
  visit(file, []);
}

const workspacePackages = [];
for (const dir of ['packages', 'projects', 'sdk']) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, dir, entry.name, 'package.json');
    try {
      workspacePackages.push({
        manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
        manifestPath,
      });
    } catch {
      // 没有 package.json 的目录不是 workspace。
    }
  }
}

if (workspacePackages.length !== 12) {
  errors.push(`workspace 包应为 12 个，实际 ${workspacePackages.length} 个`);
}

const workspaceNames = new Set(workspacePackages.map(({ manifest }) => manifest.name));
const workspaceGraph = new Map();
for (const { manifest, manifestPath } of workspacePackages) {
  const rel = relative(root, manifestPath);
  if (!String(manifest.name).startsWith('@kb/')) {
    errors.push(`${rel}: workspace 包名必须使用 @kb/ 前缀`);
  }
  if (manifest.version !== '0.1.0') {
    errors.push(`${rel}: workspace 版本必须为 0.1.0，实际 ${String(manifest.version)}`);
  }
  if (manifest.private !== true) {
    errors.push(`${rel}: workspace 包必须为 private`);
  }

  const dependencies = Object.keys(manifest.dependencies ?? {});
  workspaceGraph.set(
    manifest.name,
    dependencies.filter((name) => name.startsWith('@kb/')),
  );
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (!name.startsWith('@kb/')) continue;
      if (!workspaceNames.has(name)) {
        errors.push(`${rel}: 引用不存在的 workspace 包 ${name}`);
      }
      if (spec !== 'workspace:*') {
        errors.push(`${rel}: workspace 包 ${name} 必须使用 workspace:*，实际 ${String(spec)}`);
      }
    }
  }
}

const workspaceState = new Map();
function visitWorkspace(name, trail) {
  const status = workspaceState.get(name);
  if (status === 'done') return;
  if (status === 'visiting') {
    errors.push(`workspace 依赖成环: ${[...trail.slice(trail.indexOf(name)), name].join(' -> ')}`);
    return;
  }
  workspaceState.set(name, 'visiting');
  for (const dependency of workspaceGraph.get(name) ?? []) {
    if (workspaceNames.has(dependency)) visitWorkspace(dependency, [...trail, name]);
  }
  workspaceState.set(name, 'done');
}

for (const name of workspaceNames) visitWorkspace(name, []);

if (errors.length > 0) {
  console.error(`architecture:check 失败，共 ${errors.length} 项：`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `architecture:check 通过：扫描 ${files.length} 个 service 源文件、` +
    `${workspacePackages.length} 个 workspace 包；版本均为 0.1.0，未发现禁止依赖或循环依赖。`,
);
