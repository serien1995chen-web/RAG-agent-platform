import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 发布门禁 wiring（设计 6.2/18.10/18.11/21.24，任务 P8-01-S09）：
 * ACC-TEST-005 / TEST-LICENSE-001 / TEST-STACK-001 / TEST-STACK-002 / TEST-STACK-003。
 * 说明：SBOM 入 CI 属 personB/P8-04 等待项；本用例只校验 personA 范围的 wiring 与 catalog 闭包。
 */

const repoRoot = resolve(import.meta.dirname, '../..');

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function workspaceManifests(): Array<{ path: string; manifest: Manifest }> {
  const manifests: Array<{ path: string; manifest: Manifest }> = [];
  for (const scope of ['packages', 'projects', 'sdk']) {
    const base = join(repoRoot, scope);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(base, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      manifests.push({
        path: `${scope}/${entry.name}/package.json`,
        manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest,
      });
    }
  }
  return manifests;
}

function catalogEntries(): Map<string, string> {
  const entries = new Map<string, string>();
  let inCatalog = false;
  for (const rawLine of readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8').split(
    /\r?\n/,
  )) {
    if (/^catalog:\s*$/.test(rawLine)) {
      inCatalog = true;
      continue;
    }
    if (inCatalog && /^\S/.test(rawLine)) inCatalog = false;
    if (!inCatalog) continue;
    const match = rawLine.match(/^\s{2}'?([^':]+)'?:\s+(\S+)\s*$/);
    if (match?.[1] && match[2]) entries.set(match[1], match[2]);
  }
  return entries;
}

/** pnpm-lock.yaml importers 段的 catalog: 解析结果（specifier -> 锁定 version）。 */
function catalogResolutions(): Array<{ importer: string; name: string; version: string }> {
  const resolved: Array<{ importer: string; name: string; version: string }> = [];
  let section: string | null = null;
  let importer: string | null = null;
  let depSection: string | null = null;
  let depName: string | null = null;
  let specifier: string | null = null;
  for (const rawLine of readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8').split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = (rawLine.match(/^( *)/)?.[1] ?? '').length;
    const key = rawLine
      .trim()
      .replace(/^'|':?$/g, '')
      .replace(/:$/, '');
    if (indent === 0) {
      section = rawLine.trim().replace(':', '');
      importer = depSection = depName = specifier = null;
      continue;
    }
    if (section !== 'importers') continue;
    if (indent === 2) {
      importer = rawLine.trim().replace(/:$/, '');
      depSection = depName = specifier = null;
      continue;
    }
    if (indent === 4) {
      depSection = rawLine.trim().replace(/:$/, '');
      depName = specifier = null;
      continue;
    }
    if (indent === 6) {
      depName = key;
      specifier = null;
      continue;
    }
    if (indent === 8 && importer && depSection && depName) {
      if (rawLine.trim().startsWith('specifier:')) {
        specifier = rawLine
          .trim()
          .replace(/^specifier:\s*/, '')
          .replace(/^'|'$/g, '');
      } else if (rawLine.trim().startsWith('version:') && specifier === 'catalog:') {
        resolved.push({
          importer,
          name: depName,
          version: rawLine
            .trim()
            .replace(/^version:\s*/, '')
            .replace(/^'|'$/g, ''),
        });
      }
    }
  }
  return resolved;
}

describe('发布门禁 wiring（ACC-TEST-005 / TEST-LICENSE-001 / TEST-STACK-001…003）', () => {
  it('ACC-TEST-005 / TEST-LICENSE-001 门禁脚本与 CI wiring 存在', () => {
    const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const script of [
      'sbom:generate',
      'license:check',
      'forbidden-files:check',
      'openapi:check',
    ]) {
      expect(rootPackage.scripts[script], `scripts.${script}`).toBeDefined();
    }

    const licenseCheck = readFileSync(join(repoRoot, 'scripts/check-licenses.mjs'), 'utf8');
    expect(licenseCheck).toContain('catalog');
    expect(licenseCheck).toContain('workspace');
    expect(licenseCheck).toContain('latest');
    expect(existsSync(join(repoRoot, 'scripts/generate-sbom.mjs'))).toBe(true);

    const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    for (const gate of ['pnpm license:check', 'pnpm forbidden-files:check', 'pnpm openapi:check']) {
      expect(ci).toContain(gate);
    }
    // D5-A：SBOM 作为构建产物不入库，artifacts/ 被 gitignore。
    expect(readFileSync(join(repoRoot, '.gitignore'), 'utf8')).toContain('artifacts/');
  });

  it('TEST-STACK-001 catalog 完整性 wiring：登记项均非 latest/* 且带版本', () => {
    const catalog = catalogEntries();
    expect(catalog.size).toBeGreaterThanOrEqual(50);
    for (const [name, version] of catalog) {
      expect(version, `catalog ${name}`).not.toBe('latest');
      expect(version, `catalog ${name}`).not.toBe('*');
      expect(version.trim().length, `catalog ${name}`).toBeGreaterThan(0);
    }
  });

  it('TEST-STACK-002 依赖与 lockfile 一致：每个 catalog: 引用解析为锁定版本', () => {
    const catalog = catalogEntries();
    const workspaceNames = new Set(workspaceManifests().map((entry) => entry.manifest.name));
    const missing = workspaceManifests().flatMap(({ path, manifest }) =>
      ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(
        (section) =>
          Object.entries(manifest[section as keyof Manifest] ?? {})
            .filter(([name, spec]) => spec === 'catalog:' && !catalog.has(name))
            .map(([name]) => `${path}: ${name}`),
      ),
    );
    expect(missing).toEqual([]);

    const unresolvedWorkspaceRefs = workspaceManifests().flatMap(({ path, manifest }) =>
      ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(
        (section) =>
          Object.entries(manifest[section as keyof Manifest] ?? {})
            .filter(
              ([name, spec]) =>
                typeof spec === 'string' &&
                spec.startsWith('workspace:') &&
                !workspaceNames.has(name),
            )
            .map(([name]) => `${path}: ${name}`),
      ),
    );
    expect(unresolvedWorkspaceRefs).toEqual([]);

    const resolutions = catalogResolutions();
    expect(resolutions.length).toBeGreaterThan(0);
    const unresolved = resolutions
      .filter((entry) => !/^\d/.test(entry.version))
      .map((entry) => `${entry.importer}: ${entry.name}@${entry.version}`);
    expect(unresolved).toEqual([]);
  });

  it('TEST-STACK-003 Clean-room：workspace 依赖中无 @fastgpt-* 运行时引用', () => {
    const violations = workspaceManifests().flatMap(({ path, manifest }) =>
      ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(
        (section) =>
          Object.keys(manifest[section as keyof Manifest] ?? {})
            .filter((name) => name.startsWith('@fastgpt'))
            .map((name) => `${path}: ${name}`),
      ),
    );
    expect(violations).toEqual([]);
  });
});
