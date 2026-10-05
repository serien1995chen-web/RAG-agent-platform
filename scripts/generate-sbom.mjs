#!/usr/bin/env node
/**
 * 最小 SBOM 生成入口（骨架版，设计文档 6.2 / 18.11）。
 * 输出 artifacts/sbom.json，字段遵循 CycloneDX 1.5 最小子集；完整依赖解析在 Phase 8 接入。
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const artifactsDir = join(root, 'artifacts');
mkdirSync(artifactsDir, { recursive: true });

const components = [];
for (const dir of ['packages', 'projects', 'sdk']) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, dir, entry.name, 'package.json');
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      components.push({
        type: 'library',
        name: manifest.name,
        version: manifest.version,
        properties: [
          { name: 'kb:path', value: relative(root, join(dir, entry.name)) },
          { name: 'kb:private', value: String(manifest.private ?? false) },
        ],
      });
    } catch {
      // 忽略没有 package.json 的目录。
    }
  }
}

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: 'application', name: 'rag-agent-platform', version: '0.1.0' },
  },
  components,
};

const outPath = join(artifactsDir, 'sbom.json');
writeFileSync(outPath, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
console.log(
  `sbom:generate 完成：${relative(root, outPath)}（${components.length} 个 workspace 组件）。`,
);
