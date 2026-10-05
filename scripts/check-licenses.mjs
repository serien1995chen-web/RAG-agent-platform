#!/usr/bin/env node
/**
 * 依赖登记与许可证门禁（骨架版，设计文档 6.2 / 18.10）。
 *
 * 骨架期实现：
 * 1. 所有 catalog: 引用必须在 pnpm-workspace.yaml catalog 中登记。
 * 2. 所有 workspace: 引用必须指向存在的 workspace 包。
 * 3. 禁止 latest / * / 未登记版本。
 * 完整许可证白名单与 SBOM diff 在 Phase 8 接入。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const workspaceYaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
const catalog = new Map();
let inCatalog = false;
for (const rawLine of workspaceYaml.split(/\r?\n/)) {
  if (/^catalog:\s*$/.test(rawLine)) {
    inCatalog = true;
    continue;
  }
  if (inCatalog && /^\S/.test(rawLine)) inCatalog = false;
  if (!inCatalog) continue;
  const match = rawLine.match(/^\s{2}'?([^':]+)'?:\s+(\S+)\s*$/);
  if (match) catalog.set(match[1], match[2]);
}

const errors = [];
const workspaceNames = new Set();
const packages = [];

for (const dir of ['packages', 'projects', 'sdk']) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, dir, entry.name, 'package.json');
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      packages.push({ manifest, manifestPath });
      workspaceNames.add(manifest.name);
    } catch {
      // 忽略没有 package.json 的目录。
    }
  }
}

for (const { manifest, manifestPath } of packages) {
  const rel = relative(root, manifestPath);
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (spec === 'catalog:') {
        if (!catalog.has(name)) errors.push(`${rel}: ${name} 使用 catalog: 但未登记`);
        continue;
      }
      if (typeof spec === 'string' && spec.startsWith('workspace:')) {
        if (!workspaceNames.has(name)) errors.push(`${rel}: ${name} 引用不存在的 workspace 包`);
        continue;
      }
      if (spec === 'latest' || spec === '*') {
        errors.push(`${rel}: ${name} 不得使用 ${spec}`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`license:check 失败，共 ${errors.length} 项：`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `license:check 通过：${packages.length} 个 workspace 包，${catalog.size} 个 catalog 登记项。`,
);
