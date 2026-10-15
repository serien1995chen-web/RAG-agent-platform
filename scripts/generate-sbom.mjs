#!/usr/bin/env node
/**
 * SBOM / NOTICE 生成入口（设计文档 6.2 / 6.3 / 18.11 / 21.24）。
 *
 * - 用最小行解析器读取 pnpm-lock.yaml 的 importers/packages/snapshots 三个段，不新增 YAML 依赖。
 * - 产出四类组件：直接依赖、传递依赖、workspace 内部包、镜像组件。
 * - 同一份模型同时渲染 artifacts/sbom.json 与仓库根 NOTICE。
 *
 * 被 import 时不产生写副作用（P8-03-S02）；只有直接执行时才写文件。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PENDING_LEGAL_REVIEW, evaluateLicense, stripOuterParens } from './check-licenses.mjs';

export const PROJECT_NAME = 'rag-agent-platform';

/** 设计文档 6.3 登记的基础设施镜像（只登记常量，不 pull、不 inspect）。 */
export const IMAGE_COMPONENTS = [
  {
    service: 'mongo',
    repository: 'registry.cn-hangzhou.aliyuncs.com/fastgpt/mongo',
    tag: '5.0.32',
    digest: 'sha256:ab12670508974afbdf3bdc7dd39a201d228a73c9c13c70a684b9eedfb063dc3e',
    license: 'SSPL',
    platform: 'linux/amd64',
  },
  {
    service: 'redis',
    repository: 'registry.cn-hangzhou.aliyuncs.com/fastgpt/redis',
    tag: '7.2-alpine',
    digest: 'sha256:2bf71743152d3ca631d358029d504fed349ea28179667acfa755dffb4b321e7c',
    license: 'RSAL/SSPL',
    platform: 'linux/amd64',
  },
  {
    service: 'pgvector',
    repository: 'registry.cn-hangzhou.aliyuncs.com/fastgpt/pgvector',
    tag: '0.8.0-pg15',
    digest: 'sha256:92be4ea0424cccf17003f5803d54448e2864ac27a70e6ac5d24b3d8b463c689c',
    license: 'PostgreSQL',
    platform: 'linux/amd64',
  },
  {
    service: 'minio',
    repository: 'registry.cn-hangzhou.aliyuncs.com/fastgpt/minio',
    tag: 'RELEASE.2025-09-07T16-13-09Z',
    digest: 'sha256:a63b19df59e6ec7c02ebba6e7a1097b7e032da7947b18db7ff67dae8e84fd44d',
    license: 'AGPL-3.0',
    platform: 'linux/amd64',
  },
];

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 第三类：workspace 内部包（packages/*、projects/*、sdk/*）。 */
export function collectWorkspaceComponents(repoRoot) {
  const components = [];
  for (const scope of ['packages', 'projects', 'sdk']) {
    let entries;
    try {
      entries = readdirSync(join(repoRoot, scope), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let manifest;
      try {
        manifest = readJson(join(repoRoot, scope, entry.name, 'package.json'));
      } catch {
        continue;
      }
      components.push({
        type: 'library',
        name: manifest.name,
        version: manifest.version,
        properties: [
          { name: 'kb:component-class', value: 'workspace-package' },
          { name: 'kb:path', value: relative(repoRoot, join(scope, entry.name)) },
          { name: 'kb:private', value: String(manifest.private ?? false) },
          { name: 'kb:source', value: 'workspace' },
        ],
      });
    }
  }
  return components;
}

/** 第四类：镜像组件（常量登记，来源为设计文档 6.3）。 */
export function collectImageComponents() {
  return IMAGE_COMPONENTS.map((image) => ({
    type: 'container',
    name: `image:${image.service}`,
    version: image.tag,
    properties: [
      { name: 'kb:component-class', value: 'image-component' },
      { name: 'kb:registry-repository', value: image.repository },
      { name: 'kb:digest', value: image.digest },
      { name: 'kb:platform', value: image.platform },
      { name: 'kb:license', value: image.license },
      { name: 'kb:source', value: '设计文档 6.3' },
    ],
  }));
}

function stripQuotes(value) {
  const text = String(value).trim();
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function keyOf(line) {
  const text = line.trim();
  const index = text.indexOf(':');
  if (index <= 0) return null;
  const key = stripQuotes(text.slice(0, index));
  return key.length > 0 ? key : null;
}

/** 去掉 pnpm 快照键的 peer 后缀：`next@16.3.0(...)` → `next@16.3.0`。 */
function normalizePackageKey(key) {
  return String(key)
    .replace(/\(.*\)$/, '')
    .trim();
}

/** 去掉解析版本里的 peer/构建后缀：`4.1.11(vitest@4.1.11)` → `4.1.11`。 */
function cleanVersion(value) {
  return String(value)
    .replace(/\(.*\)$/, '')
    .split('_')[0]
    .trim();
}

function isLocalRef(value) {
  const text = String(value);
  return text.startsWith('link:') || text.startsWith('workspace:');
}

/**
 * pnpm-lock.yaml 最小行解析器（lockfileVersion 9.0）。
 * 只读取 importers / packages / snapshots 三段，不新增 YAML 解析依赖。
 */
export function parseLockfile(text) {
  const importers = new Map();
  const integrity = new Map();
  const snapshots = new Map();
  let section = null;
  let importer = null;
  let depSection = null;
  let depName = null;
  let packageKey = null;
  let snapshotKey = null;
  let inSnapshotDependencies = false;

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim().length === 0 || rawLine.trim().startsWith('#')) continue;
    const indent = (rawLine.match(/^( *)/)?.[1] ?? '').length;
    if (indent === 0) {
      section = rawLine.trim().replace(/:$/, '');
      importer = depSection = depName = packageKey = snapshotKey = null;
      inSnapshotDependencies = false;
      continue;
    }

    if (section === 'importers') {
      if (indent === 2) {
        const key = keyOf(rawLine);
        if (key === null) continue;
        importer = key;
        importers.set(importer, {
          dependencies: {},
          devDependencies: {},
          optionalDependencies: {},
        });
        depSection = depName = null;
      } else if (indent === 4) {
        depSection = keyOf(rawLine);
      } else if (indent === 6 && importer !== null && depSection !== null) {
        depName = keyOf(rawLine);
      } else if (indent === 8 && importer !== null && depSection !== null && depName !== null) {
        const match = rawLine.trim().match(/^version:\s*(.+)$/);
        if (match) importers.get(importer)[depSection][depName] = stripQuotes(match[1]);
      }
      continue;
    }

    if (section === 'packages') {
      if (indent === 2) {
        const key = keyOf(rawLine);
        if (key === null) continue;
        packageKey = normalizePackageKey(key);
        integrity.set(packageKey, '');
      } else if (indent === 4 && packageKey !== null) {
        const match = rawLine.trim().match(/^resolution:\s*\{(.*)\}$/);
        const found = match?.[1]?.match(/integrity:\s*([^,}]+)/);
        if (found) integrity.set(packageKey, found[1].trim());
      }
      continue;
    }

    if (section === 'snapshots') {
      if (indent === 2) {
        const key = keyOf(rawLine);
        if (key === null) continue;
        snapshotKey = normalizePackageKey(key);
        if (!snapshots.has(snapshotKey)) snapshots.set(snapshotKey, { dependencies: {} });
        inSnapshotDependencies = false;
      } else if (indent === 4) {
        inSnapshotDependencies = keyOf(rawLine) === 'dependencies';
      } else if (indent === 6 && snapshotKey !== null && inSnapshotDependencies) {
        const text = rawLine.trim();
        const index = text.lastIndexOf(':');
        if (index > 0) {
          const name = stripQuotes(text.slice(0, index));
          const version = stripQuotes(text.slice(index + 1));
          snapshots.get(snapshotKey).dependencies[name] = version;
        }
      }
    }
  }

  return { importers, integrity, snapshots };
}

function readLicenseField(manifest) {
  if (typeof manifest.license === 'string' && manifest.license.trim().length > 0) {
    return manifest.license.trim();
  }
  if (
    manifest.license !== null &&
    typeof manifest.license === 'object' &&
    typeof manifest.license.type === 'string'
  ) {
    return manifest.license.type;
  }
  if (Array.isArray(manifest.licenses)) {
    const parts = manifest.licenses
      .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
      .filter((entry) => typeof entry === 'string' && entry.length > 0);
    if (parts.length > 0) return parts.join(' OR ');
  }
  return 'UNKNOWN';
}

/** 已安装包索引：name@version → { dir, license }（用于读取 license 字段与 LICENSE 文本）。 */
export function collectInstalledPackages(repoRoot) {
  const installed = new Map();
  const pnpmDir = join(repoRoot, 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) return installed;
  for (const dir of readdirSync(pnpmDir)) {
    const nodeModules = join(pnpmDir, dir, 'node_modules');
    if (!existsSync(nodeModules)) continue;
    for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidates = entry.name.startsWith('@')
        ? readdirSync(join(nodeModules, entry.name)).map((sub) =>
            join(nodeModules, entry.name, sub),
          )
        : [join(nodeModules, entry.name)];
      for (const candidate of candidates) {
        const manifestPath = join(candidate, 'package.json');
        if (!existsSync(manifestPath)) continue;
        try {
          const manifest = readJson(manifestPath);
          if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue;
          installed.set(`${manifest.name}@${manifest.version}`, {
            dir: candidate,
            license: readLicenseField(manifest),
          });
        } catch {
          // 忽略损坏或不完整的安装目录。
        }
      }
    }
  }
  return installed;
}

const LICENSE_FILE_CANDIDATES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENSE-MIT',
  'license',
  'LICENCE',
];

function readLicenseText(packageDir) {
  for (const name of LICENSE_FILE_CANDIDATES) {
    const file = join(packageDir, name);
    if (!existsSync(file)) continue;
    try {
      return readFileSync(file, 'utf8');
    } catch {
      // 尝试下一个候选文件。
    }
  }
  return '';
}

/** 裸 BSD 声明：仅当 LICENSE 文本匹配 BSD-2-Clause/BSD-3-Clause 时才归一化。 */
export function detectBsdVariant(text) {
  if (/BSD[- ]2[- ]Clause/i.test(text)) return 'BSD-2-Clause';
  if (/BSD[- ]3[- ]Clause/i.test(text)) return 'BSD-3-Clause';
  const redistributionSource = /Redistributions of source code must retain/i.test(text);
  const redistributionBinary = /Redistributions in binary form must reproduce/i.test(text);
  if (!redistributionSource || !redistributionBinary) return '';
  const hasEndorsementClause = /Neither the name|endorse or promote/i.test(text);
  return hasEndorsementClause ? 'BSD-3-Clause' : 'BSD-2-Clause';
}

export function normalizeLicense(declared, packageDir) {
  const raw = String(declared ?? '').trim();
  if (raw.length === 0 || raw === 'UNKNOWN') {
    return { declared: 'UNKNOWN', normalized: 'UNKNOWN', resolution: 'unknown' };
  }
  const evaluation = evaluateLicense(raw);
  if (evaluation.kind === 'or') {
    const resolved = evaluation.approved
      ? evaluation.selected
      : evaluation.parts.map((part) => stripOuterParens(part)).join(' OR ');
    return { declared: raw, normalized: resolved, resolution: 'spdx-or' };
  }
  if (evaluation.kind === 'and') {
    return {
      declared: raw,
      normalized: evaluation.parts.map((part) => stripOuterParens(part)).join(' AND '),
      resolution: 'spdx-and',
    };
  }
  if (/^BSD$/i.test(raw)) {
    const detected = detectBsdVariant(readLicenseText(packageDir));
    if (detected.length > 0) {
      return { declared: raw, normalized: detected, resolution: 'license-text' };
    }
  }
  return { declared: raw, normalized: stripOuterParens(raw), resolution: 'declared' };
}

function bfsClosure(snapshots, roots) {
  const seen = new Set();
  const parent = new Map();
  const queue = [];
  for (const [name, version, importer] of roots) {
    const key = `${name}@${version}`;
    if (!parent.has(key)) parent.set(key, importer);
    queue.push(key);
  }
  while (queue.length > 0) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    seen.add(key);
    const snapshot = snapshots.get(key);
    if (snapshot === undefined) continue;
    for (const [name, version] of Object.entries(snapshot.dependencies)) {
      if (isLocalRef(version)) continue;
      const dependencyKey = `${name}@${cleanVersion(version)}`;
      if (!parent.has(dependencyKey)) parent.set(dependencyKey, key);
      queue.push(dependencyKey);
    }
  }
  return { keys: seen, parent };
}

function parentChainOf(key, parent) {
  const chain = [key];
  let current = parent.get(key);
  let guard = 0;
  while (typeof current === 'string' && current.includes('@') && guard < 32) {
    chain.unshift(current);
    current = parent.get(current);
    guard += 1;
  }
  return typeof current === 'string' ? [current, ...chain].join(' → ') : chain.join(' → ');
}

function splitPackageKey(key) {
  const index = key.lastIndexOf('@');
  return [key.slice(0, index), key.slice(index + 1)];
}

function addDirect(directByKey, name, version, scope, importer) {
  const key = `${name}@${version}`;
  const existing = directByKey.get(key);
  if (existing === undefined) {
    directByKey.set(key, {
      name,
      version,
      scopes: new Set([scope]),
      importers: new Set([importer]),
    });
    return;
  }
  existing.scopes.add(scope);
  existing.importers.add(importer);
}

/** 第一、二类：直接依赖与传递依赖（生产/开发闭包 + 依赖父链 + integrity）。 */
export function collectDependencyComponents(lockfile, installed) {
  const directByKey = new Map();
  const productionRoots = [];
  const developmentRoots = [];

  for (const [importer, sections] of lockfile.importers) {
    for (const [name, version] of Object.entries(sections.dependencies)) {
      if (isLocalRef(version)) continue;
      const cleaned = cleanVersion(version);
      addDirect(directByKey, name, cleaned, 'production', importer);
      productionRoots.push([name, cleaned, importer]);
    }
    for (const [name, version] of Object.entries(sections.optionalDependencies)) {
      if (isLocalRef(version)) continue;
      const cleaned = cleanVersion(version);
      addDirect(directByKey, name, cleaned, 'production', importer);
      productionRoots.push([name, cleaned, importer]);
    }
    for (const [name, version] of Object.entries(sections.devDependencies)) {
      if (isLocalRef(version)) continue;
      const cleaned = cleanVersion(version);
      addDirect(directByKey, name, cleaned, 'development', importer);
      developmentRoots.push([name, cleaned, importer]);
    }
  }

  const production = bfsClosure(lockfile.snapshots, productionRoots);
  const development = bfsClosure(lockfile.snapshots, developmentRoots);
  const allKeys = new Set([...production.keys, ...development.keys]);
  const parent = new Map([...development.parent, ...production.parent]);

  const directComponents = [...directByKey.entries()]
    .map(([key, entry]) => {
      const [name, version] = splitPackageKey(key);
      return {
        type: 'library',
        name,
        version,
        properties: [
          { name: 'kb:component-class', value: 'direct-dependency' },
          {
            name: 'kb:scope',
            value: entry.scopes.has('production') ? 'production' : 'development',
          },
          { name: 'kb:workspaces', value: [...entry.importers].sort().join(',') },
          { name: 'kb:source', value: 'pnpm-lock.yaml:importers' },
        ],
      };
    })
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
    );

  const transitiveComponents = [...allKeys]
    .filter((key) => !directByKey.has(key))
    .map((key) => {
      const [name, version] = splitPackageKey(key);
      return {
        type: 'library',
        name,
        version,
        properties: [
          { name: 'kb:component-class', value: 'transitive-dependency' },
          {
            name: 'kb:scope',
            value: production.keys.has(key) ? 'production' : 'development',
          },
          { name: 'kb:parent-chain', value: parentChainOf(key, parent) },
          { name: 'kb:integrity', value: lockfile.integrity.get(key) ?? '' },
          { name: 'kb:source', value: 'pnpm-lock.yaml:snapshots' },
        ],
      };
    })
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
    );

  const licenseEntries = [...allKeys]
    .map((key) => {
      const [name, version] = splitPackageKey(key);
      const packageInfo = installed.get(key);
      const normalized = normalizeLicense(
        packageInfo?.license ?? 'UNKNOWN',
        packageInfo?.dir ?? '',
      );
      return {
        name,
        version,
        scope: production.keys.has(key) ? 'production' : 'development',
        declared: normalized.declared,
        normalized: normalized.normalized,
        resolution: normalized.resolution,
        parentChain: parentChainOf(key, parent),
      };
    })
    .sort((left, right) =>
      `${left.scope}:${left.name}@${left.version}`.localeCompare(
        `${right.scope}:${right.name}@${right.version}`,
      ),
    );

  const releaseBlockers = licenseEntries
    .filter((entry) => entry.scope === 'production')
    .flatMap((entry) => {
      const pending = PENDING_LEGAL_REVIEW.find(
        (candidate) => candidate.name === entry.name && candidate.version === entry.version,
      );
      return pending === undefined
        ? []
        : [
            {
              ...pending,
              license: entry.normalized,
              resolvedParentChain: entry.parentChain,
            },
          ];
    });

  return {
    directComponents,
    transitiveComponents,
    licenseEntries,
    releaseBlockers,
    productionKeys: production.keys,
  };
}

export function collectSbomModel(repoRoot) {
  const project = readJson(join(repoRoot, 'package.json'));
  const lockfile = parseLockfile(readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8'));
  const installed = collectInstalledPackages(repoRoot);
  const dependencies = collectDependencyComponents(lockfile, installed);
  const workspaceComponents = collectWorkspaceComponents(repoRoot);
  const imageComponents = collectImageComponents();
  const components = [
    ...dependencies.directComponents,
    ...dependencies.transitiveComponents,
    ...workspaceComponents,
    ...imageComponents,
  ];
  const forbidden = components
    .map((component) => component.name)
    .filter((name) => /^@fastgpt(-sdk)?\//.test(name));
  if (forbidden.length > 0) {
    throw new Error(`SBOM 不允许出现 @fastgpt-* 组件: ${forbidden.join(', ')}`);
  }
  return {
    project: { name: project.name ?? PROJECT_NAME, version: project.version ?? '0.0.0' },
    generatedAt: new Date().toISOString(),
    directComponents: dependencies.directComponents,
    transitiveComponents: dependencies.transitiveComponents,
    workspaceComponents,
    imageComponents,
    licenseEntries: dependencies.licenseEntries,
    releaseBlockers: dependencies.releaseBlockers,
  };
}

export function classCounts(components) {
  const counts = new Map();
  for (const component of components) {
    const value =
      component.properties.find((property) => property.name === 'kb:component-class')?.value ??
      'unknown';
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

export function buildSbomDocument(model) {
  const components = [
    ...(model.directComponents ?? []),
    ...(model.transitiveComponents ?? []),
    ...model.workspaceComponents,
    ...model.imageComponents,
  ];
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      timestamp: model.generatedAt,
      component: { type: 'application', name: model.project.name, version: model.project.version },
    },
    components,
  };
}

function propertyValue(component, name) {
  return component.properties.find((property) => property.name === name)?.value ?? '';
}

/**
 * NOTICE 渲染：只由 `pnpm sbom:generate` 产出，禁止手工维护。
 * 除 `生成时间:` 一行外，全部内容按 name+version 确定性排序。
 */
export function renderNotice(model) {
  const licenseById = new Map(
    model.licenseEntries.map((entry) => [`${entry.name}@${entry.version}`, entry]),
  );
  const licenseOf = (component) => {
    const entry = licenseById.get(`${component.name}@${component.version}`);
    return entry === undefined ? propertyValue(component, 'kb:license') : entry.normalized;
  };
  const lines = [];

  lines.push('NOTICE', '======', '', `项目: ${model.project.name} ${model.project.version}`, '');
  lines.push(`生成时间: ${model.generatedAt}`);
  lines.push('生成命令: pnpm sbom:generate');
  lines.push('生成脚本: scripts/generate-sbom.mjs（禁止手工维护本文件）');
  lines.push('SBOM 产物: artifacts/sbom.json');
  lines.push('');

  lines.push(`一、直接依赖（${model.directComponents.length}）`);
  lines.push('名称@版本 | 许可证 | scope | 来源 workspace');
  for (const component of model.directComponents) {
    lines.push(
      `${component.name}@${component.version} | ${licenseOf(component)} | ` +
        `${propertyValue(component, 'kb:scope')} | ${propertyValue(component, 'kb:workspaces')}`,
    );
  }
  lines.push('');

  lines.push(`二、传递依赖（${model.transitiveComponents.length}）`);
  lines.push('名称@版本 | 许可证 | scope | 依赖父链');
  for (const component of model.transitiveComponents) {
    lines.push(
      `${component.name}@${component.version} | ${licenseOf(component)} | ` +
        `${propertyValue(component, 'kb:scope')} | ${propertyValue(component, 'kb:parent-chain')}`,
    );
  }
  lines.push('');

  lines.push(`三、workspace 内部包（${model.workspaceComponents.length}）`);
  lines.push('名称@版本 | 路径 | private');
  for (const component of model.workspaceComponents) {
    lines.push(
      `${component.name}@${component.version} | ${propertyValue(component, 'kb:path')} | ` +
        `${propertyValue(component, 'kb:private')}`,
    );
  }
  lines.push('');

  lines.push(`四、镜像组件（${model.imageComponents.length}）`);
  lines.push('服务 | registry/repository | tag | digest | 许可证 | 平台');
  for (const image of IMAGE_COMPONENTS) {
    lines.push(
      `${image.service} | ${image.repository} | ${image.tag} | ${image.digest} | ` +
        `${image.license} | ${image.platform}`,
    );
  }
  lines.push('');

  lines.push('五、许可证白名单（两套清单分开）');
  lines.push(
    'npm 生产闭包白名单: MIT、Apache-2.0、BSD-2-Clause、BSD-3-Clause、ISC、0BSD；字体另允许 OFL-1.1',
  );
  lines.push(
    '容器镜像白名单: mongo=SSPL、redis=RSAL/SSPL、minio=AGPL-3.0、pgvector=PostgreSQL License',
  );
  lines.push('');

  lines.push(
    `六、发布阻塞项（pending-legal-review，releaseBlocking=true，${model.releaseBlockers.length} 条）`,
  );
  lines.push('说明: 以下条目不阻断 CI，但阻断对外发布，待法务复核；不得声明为已批准。');
  for (const blocker of model.releaseBlockers) {
    lines.push(
      `${blocker.name}@${blocker.version} | ${blocker.expression} | ${blocker.status} | ` +
        `releaseBlocking=${String(blocker.releaseBlocking)} | ${blocker.resolvedParentChain}`,
    );
  }
  lines.push('');

  lines.push('七、Clean-room 声明');
  lines.push('本项目为自研 clean-room 实现，未复制参照仓库内容。');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

export function writeSbomArtifacts(repoRoot, model) {
  const artifactsDir = join(repoRoot, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  const document = buildSbomDocument(model);
  const sbomPath = join(artifactsDir, 'sbom.json');
  writeFileSync(sbomPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  const noticePath = join(repoRoot, 'NOTICE');
  writeFileSync(noticePath, renderNotice(model), 'utf8');
  return { sbomPath, noticePath, document, counts: classCounts(document.components) };
}

export function main() {
  const repoRoot = resolve(import.meta.dirname, '..');
  const model = collectSbomModel(repoRoot);
  const { sbomPath, noticePath, counts } = writeSbomArtifacts(repoRoot, model);
  const summary = [...counts.entries()].map(([name, count]) => `${name}=${count}`).join(' ');
  console.log(
    `sbom:generate 完成：${relative(repoRoot, sbomPath)}、${relative(repoRoot, noticePath)}（${summary}）。`,
  );
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) main();
