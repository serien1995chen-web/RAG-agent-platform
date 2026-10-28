#!/usr/bin/env node
/**
 * 依赖登记与许可证门禁（设计文档 6.2 / 6.3 / 18.10 / ADR-019；N6-A 裁决）。
 *
 * 检查项：
 * 1. 既有三项不削弱：catalog: 已登记 / workspace: 指向存在包 / 禁止 latest、*。
 * 2. npm 生产闭包白名单：SPDX OR 命中任一白名单分支即通过并记录所选分支；
 *    AND 要求全部分支命中；裸 BSD 读取包内 LICENSE 文本归一化为 BSD-2/3-Clause。
 * 3. N6-A `PENDING_LEGAL_REVIEW` 例外表（精确 name@version，仅 5 条）：
 *    命中即退出 0，但必须输出 `RELEASE BLOCKER`，并登记到 NOTICE 与 release.md。
 * 4. 容器镜像白名单单独一套（与 npm 清单分开）。
 * 5. dev/build-only 白名单外许可证记非阻塞审计，不阻断。
 * 6. SBOM diff：与既有 artifacts/sbom.json 比对组件集合差异（新增/移除）。
 *
 * 模块被 import 时不产生副作用（generate-sbom.mjs 复用同一份声明）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** npm 白名单（ADR-019 代码）与字体白名单。 */
export const NPM_LICENSE_WHITELIST = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'OFL-1.1',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
];

/**
 * NPM aliases and legacy dual-license metadata that the SBOM collector cannot
 * associate with the installed manifest. Every value is taken from the
 * installed package's declared license or LICENSE file.
 */
export const NORMALIZED_DECLARED_LICENSES = new Map([
  ['pause-stream@0.0.11', 'MIT'],
  ['string-width-cjs@string-width@4.2.3', 'MIT'],
  ['strip-ansi-cjs@strip-ansi@6.0.1', 'MIT'],
  ['wrap-ansi-cjs@wrap-ansi@7.0.0', 'MIT'],
]);

/**
 * N6-A 生产闭包例外表：只登记 5 条待法务复核项。
 * 状态固定为 `pending-legal-review`，`releaseBlocking: true` 表示阻断发布、但不阻断 CI。
 */
export const PENDING_LEGAL_REVIEW = [
  {
    name: 'pako',
    version: '1.0.11',
    expression: '(MIT AND Zlib)',
    parentChain: 'packages/parse → mammoth@1.11.0 → jszip@3.10.2 → pako@1.0.11',
    status: 'pending-legal-review',
    releaseBlocking: true,
  },
  {
    name: 'sax',
    version: '1.6.1',
    expression: 'BlueOak-1.0.0',
    parentChain: 'sdk/storage → minio@8.0.7 → xml2js@0.6.2 → sax@1.6.1',
    status: 'pending-legal-review',
    releaseBlocking: true,
  },
  {
    name: 'caniuse-lite',
    version: '1.0.30001814',
    expression: 'CC-BY-4.0',
    parentChain: 'projects/app → next@16.3.0 → caniuse-lite@1.0.30001814',
    status: 'pending-legal-review',
    releaseBlocking: true,
  },
  {
    name: 'argparse',
    version: '2.0.1',
    expression: 'Python-2.0',
    parentChain:
      'packages/service → @apidevtools/json-schema-ref-parser@11.7.2 → js-yaml@4.3.2 → argparse@2.0.1',
    status: 'pending-legal-review',
    releaseBlocking: true,
  },
  {
    name: 'jschardet',
    version: '3.1.1',
    expression: 'LGPL-2.1+',
    parentChain: 'packages/parse → jschardet@3.1.1',
    status: 'pending-legal-review',
    releaseBlocking: true,
  },
];

/** 容器镜像白名单（与 npm 包白名单分开登记）。 */
export const IMAGE_LICENSE_WHITELIST = [
  { service: 'mongo', license: 'SSPL', confirmedBy: '设计 6.2' },
  { service: 'redis', license: 'RSAL/SSPL', confirmedBy: '设计 6.2' },
  { service: 'minio', license: 'AGPL-3.0', confirmedBy: '设计 6.2' },
  { service: 'pgvector', license: 'PostgreSQL', confirmedBy: 'N2-A 用户确认' },
];

const EXACT_DEPENDENCY_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const FORBIDDEN_DEPENDENCY_NAMES = /^@fastgpt-|^@fastgpt-sdk\/|^@kb-sdk\//;
const DESIGN_DEPENDENCY_SOURCES = new Set(['PROJECT_BASELINE', 'FASTGPT_SUPPLEMENT']);
const TEST_ONLY_SOURCE = 'USER_APPROVED_S1_BROWSER_E2E';
const EXPECTED_TEST_ONLY = new Map([
  ['@playwright/test', '1.64.1'],
  ['@axe-core/playwright', '4.14.0'],
]);
const EXPECTED_STAGE_COUNTS = new Map([
  ['S1', 91],
  ['S2', 13],
  ['S3', 0],
  ['S4', 24],
  ['S5', 2],
  ['S6', 6],
  ['S7', 21],
  ['S8', 1],
  ['S9', 0],
  ['S10', 6],
  ['S11', 0],
]);
const CATALOG_ONLY_LATER_STAGE = new Set(['ajv', '@llamaindex/liteparse-wasm', '@types/turndown']);
const APPROVED_S5_DIRECT_DEPENDENCIES = new Set(['@llamaindex/liteparse-wasm', '@types/turndown']);
const DEPENDENCY_STAGES = new Set([
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'S6',
  'S7',
  'S8',
  'S9',
  'S10',
  'S11',
]);
const DEPENDENCY_SOURCES = new Set(['PROJECT_BASELINE', 'FASTGPT_SUPPLEMENT', TEST_ONLY_SOURCE]);
const DECLARED_DEPENDENCY_STAGES = new Set(['S1', 'S2', 'S4', 'S6', 'S7', 'S8']);
const AUDIT_CATEGORIES = new Map([
  ['DECLARED_INSTALLED', 52],
  ['DECLARED_NOT_INSTALLED', 5],
  ['UNDECLARED_INSTALLED', 15],
  ['UNDECLARED_NOT_INSTALLED', 92],
]);
const BASELINE_TRANSITIVE_ONLY = new Set([
  '@opentelemetry/api-logs',
  '@opentelemetry/semantic-conventions',
  '@xmldom/xmldom',
  'cron-parser',
  'esbuild',
  'form-data',
  'http-proxy-agent',
  'https-proxy-agent',
  'iconv-lite',
  'ipaddr.js',
  'jszip',
  'nanoid',
  'p-limit',
  'proxy-from-env',
  'vite',
]);

export function findPendingException(name, version) {
  return PENDING_LEGAL_REVIEW.find((entry) => entry.name === name && entry.version === version);
}

export function stripOuterParens(expression) {
  let value = String(expression ?? '').trim();
  while (value.startsWith('(') && value.endsWith(')')) {
    const inner = value.slice(1, -1);
    let depth = 0;
    let balanced = true;
    for (const char of inner) {
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth < 0) balanced = false;
      }
    }
    if (!balanced || depth !== 0) break;
    value = inner.trim();
  }
  return value;
}

/** 按顶层运算符切分 SPDX 表达式（括号内不切分）。 */
export function splitTopLevel(expression, operator) {
  const value = stripOuterParens(expression);
  const parts = [];
  let depth = 0;
  let current = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    if (depth === 0 && value.startsWith(operator, index)) {
      parts.push(current);
      current = '';
      index += operator.length - 1;
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * 白名单判定：OR 命中任一分支即通过并记录所选分支；AND 要求全部分支命中。
 */
export function evaluateLicense(expression, whitelist = new Set(NPM_LICENSE_WHITELIST)) {
  const raw = String(expression ?? '').trim();
  if (raw.length === 0 || raw === 'UNKNOWN') return { approved: false, kind: 'unknown' };

  const orParts = splitTopLevel(raw, ' OR ');
  if (orParts.length > 1) {
    const selected = orParts.find((part) => evaluateLicense(part, whitelist).approved);
    return selected === undefined
      ? { approved: false, kind: 'or', parts: orParts }
      : { approved: true, kind: 'or', selected: stripOuterParens(selected), parts: orParts };
  }

  const andParts = splitTopLevel(raw, ' AND ');
  if (andParts.length > 1) {
    return {
      approved: andParts.every((part) => evaluateLicense(part, whitelist).approved),
      kind: 'and',
      parts: andParts,
    };
  }

  const single = stripOuterParens(raw);
  return { approved: whitelist.has(single), kind: 'single', value: single };
}

function parseCatalog(workspaceYaml) {
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
  return catalog;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function collectPackageManifests(repoRoot) {
  const manifests = [];
  const rootPath = join(repoRoot, 'package.json');
  manifests.push({ manifest: readJson(rootPath), manifestPath: rootPath, workspace: false });

  for (const dir of ['packages', 'projects', 'sdk']) {
    for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(repoRoot, dir, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      manifests.push({
        manifest: readJson(manifestPath),
        manifestPath,
        workspace: true,
      });
    }
  }
  return manifests;
}

/** 既有三项检查（不得削弱）：catalog 登记 / workspace 引用 / 禁止 latest、*。 */
function checkRegistrations(repoRoot, catalog) {
  const errors = [];
  const workspaceNames = new Set();
  const manifests = collectPackageManifests(repoRoot);
  for (const { manifest, workspace } of manifests) {
    if (workspace) workspaceNames.add(manifest.name);
  }

  for (const { manifest, manifestPath } of manifests) {
    const rel = relative(repoRoot, manifestPath);
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
        if (FORBIDDEN_DEPENDENCY_NAMES.test(name)) {
          errors.push(`${rel}: ${name} 是禁止依赖`);
        }
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
          continue;
        }
        errors.push(`${rel}: 外部依赖 ${name} 必须使用 catalog:`);
      }
    }
  }

  return {
    errors,
    workspaceCount: manifests.filter((item) => item.workspace).length,
    manifests,
  };
}

function checkDependencyBaseline(repoRoot, catalog, manifests, options = {}) {
  const { skipInstallationChecks = false } = options;
  const errors = [];
  const ledger = readJson(
    join(
      repoRoot,
      'packages',
      'contracts',
      'src',
      'dependencies',
      'npm-dependency-baseline.data.json',
    ),
  );
  if (!Array.isArray(ledger)) {
    return ['dependency ledger 必须是数组'];
  }
  if (ledger.length !== 166) errors.push(`dependency ledger 应为 166 项，实际 ${ledger.length}`);

  const names = new Set();
  const byName = new Map();
  for (const [index, entry] of ledger.entries()) {
    if (typeof entry?.name !== 'string' || entry.name.length === 0) {
      errors.push(`dependency ledger[${index}] 缺少 name`);
      continue;
    }
    if (names.has(entry.name)) errors.push(`dependency ledger 名称重复: ${entry.name}`);
    names.add(entry.name);
    byName.set(entry.name, entry);
    if (FORBIDDEN_DEPENDENCY_NAMES.test(entry.name)) {
      errors.push(`dependency ledger 禁止依赖: ${entry.name}`);
    }
    if (!EXACT_DEPENDENCY_VERSION.test(entry.version)) {
      errors.push(`${entry.name}: 版本必须精确，实际 ${entry.version}`);
    }
    if (!DEPENDENCY_STAGES.has(entry.ownerStage)) {
      errors.push(`${entry.name}: 未知 ownerStage ${String(entry.ownerStage)}`);
    }
    if (!DEPENDENCY_SOURCES.has(entry.source)) {
      errors.push(`${entry.name}: 未知 source ${String(entry.source)}`);
    }
  }

  const designEntries = ledger.filter((entry) => DESIGN_DEPENDENCY_SOURCES.has(entry.source));
  if (designEntries.length !== 164) {
    errors.push(`设计直接依赖应为 164 项，实际 ${designEntries.length}`);
  }
  const stageCounts = new Map();
  for (const entry of designEntries) {
    stageCounts.set(entry.ownerStage, (stageCounts.get(entry.ownerStage) ?? 0) + 1);
  }
  for (const [stage, expected] of EXPECTED_STAGE_COUNTS) {
    const actual = stageCounts.get(stage) ?? 0;
    if (actual !== expected) {
      errors.push(`ownerStage ${stage} 应为 ${expected} 项，实际 ${actual}`);
    }
  }

  for (const [name, version] of EXPECTED_TEST_ONLY) {
    const entry = byName.get(name);
    if (entry === undefined) {
      errors.push(`缺少 test-only 授权项 ${name}@${version}`);
      continue;
    }
    if (entry.version !== version) {
      errors.push(`${name}: test-only 版本应为 ${version}，实际 ${entry.version}`);
    }
    if (
      entry.source !== TEST_ONLY_SOURCE ||
      entry.ownerStage !== 'S1' ||
      entry.scope !== 'TEST_ONLY'
    ) {
      errors.push(`${name}: test-only source/stage/scope 不正确`);
    }
  }

  const expectedCatalog = new Map(
    ledger
      .filter(
        (entry) =>
          DECLARED_DEPENDENCY_STAGES.has(entry.ownerStage) ||
          CATALOG_ONLY_LATER_STAGE.has(entry.name),
      )
      .map((entry) => [entry.name, entry.version]),
  );
  if (expectedCatalog.size !== 160) {
    errors.push(`catalog 期望项应为 160，账本计算为 ${expectedCatalog.size}`);
  }
  if (catalog.size !== 160) errors.push(`catalog 应为 160 项，实际 ${catalog.size}`);
  for (const [name, version] of expectedCatalog) {
    const actual = catalog.get(name);
    if (actual === undefined) errors.push(`catalog 缺少 ${name}@${version}`);
    else if (actual !== version) {
      errors.push(`${name}: catalog 版本漂移，期望 ${version}，实际 ${actual}`);
    }
  }
  for (const [name, version] of catalog) {
    if (!EXACT_DEPENDENCY_VERSION.test(version)) {
      errors.push(`${name}: catalog 版本必须精确，实际 ${version}`);
    }
    if (!expectedCatalog.has(name)) errors.push(`catalog 出现未登记依赖 ${name}`);
  }
  for (const removed of ['@opentelemetry/instrumentation', 'js-yaml']) {
    if (catalog.has(removed)) errors.push(`catalog 不得包含 ${removed}`);
  }

  const root = manifests.find(
    ({ manifestPath }) => manifestPath === join(repoRoot, 'package.json'),
  );
  for (const name of EXPECTED_TEST_ONLY.keys()) {
    if (!Object.hasOwn(root?.manifest.devDependencies ?? {}, name)) {
      errors.push(`${name}: 必须只在根 devDependencies 登记`);
    }
    if (Object.hasOwn(root?.manifest.dependencies ?? {}, name)) {
      errors.push(`${name}: 不得进入根 dependencies`);
    }
    for (const { manifest, manifestPath, workspace } of manifests) {
      if (!workspace) continue;
      if (
        Object.hasOwn(manifest.dependencies ?? {}, name) ||
        Object.hasOwn(manifest.devDependencies ?? {}, name)
      ) {
        errors.push(`${relative(repoRoot, manifestPath)}: test-only 依赖 ${name} 越界`);
      }
    }
  }

  for (const { manifest, manifestPath, workspace } of manifests) {
    const rel = relative(repoRoot, manifestPath);
    for (const section of ['dependencies', 'devDependencies']) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        if (name.startsWith('@kb/')) continue;
        const entry = byName.get(name);
        if (entry === undefined) {
          errors.push(`${rel}: 直接依赖 ${name} 未登记在 dependency ledger`);
          continue;
        }
        const approvedS5Direct =
          entry.ownerStage === 'S5' && APPROVED_S5_DIRECT_DEPENDENCIES.has(name);
        if (workspace && !DECLARED_DEPENDENCY_STAGES.has(entry.ownerStage) && !approvedS5Direct) {
          errors.push(`${rel}: 后续阶段依赖 ${name} 不得提前直接声明`);
        }
        if (!skipInstallationChecks) {
          const installedManifest = join(
            dirname(manifestPath),
            'node_modules',
            ...name.split('/'),
            'package.json',
          );
          try {
            const installed = readJson(installedManifest);
            if (installed.version !== entry.version) {
              errors.push(
                `${rel}: ${name} 实际安装 ${String(installed.version)}，期望 ${entry.version}`,
              );
            }
          } catch {
            errors.push(`${rel}: ${name} 未安装`);
          }
        }
      }
    }
  }

  return errors;
}

function checkDependencyAudit(repoRoot) {
  const errors = [];
  const ledger = readJson(
    join(
      repoRoot,
      'packages',
      'contracts',
      'src',
      'dependencies',
      'npm-dependency-baseline.data.json',
    ),
  );
  const audit = readJson(
    join(
      repoRoot,
      'packages',
      'contracts',
      'src',
      'dependencies',
      'npm-dependency-audit.data.json',
    ),
  );
  if (!Array.isArray(audit)) return ['dependency audit 必须是数组'];
  if (audit.length !== 166) errors.push(`dependency audit 应为 166 项，实际 ${audit.length}`);

  const ledgerByName = new Map(ledger.map((entry) => [entry.name, entry]));
  const auditNames = new Set();
  for (const [index, entry] of audit.entries()) {
    if (typeof entry?.name !== 'string' || entry.name.length === 0) {
      errors.push(`dependency audit[${index}] 缺少 name`);
      continue;
    }
    if (auditNames.has(entry.name)) errors.push(`dependency audit 名称重复: ${entry.name}`);
    auditNames.add(entry.name);
    const ledgerEntry = ledgerByName.get(entry.name);
    if (ledgerEntry === undefined) {
      errors.push(`${entry.name}: dependency audit 不在 ledger 中`);
    } else {
      if (entry.designVersion !== ledgerEntry.version) {
        errors.push(`${entry.name}: audit designVersion 与 ledger 不一致`);
      }
      if (entry.ownerStage !== ledgerEntry.ownerStage) {
        errors.push(`${entry.name}: audit ownerStage 与 ledger 不一致`);
      }
      if (entry.source !== ledgerEntry.source) {
        errors.push(`${entry.name}: audit source 与 ledger 不一致`);
      }
    }

    for (const field of [
      'baselineDeclaration',
      'baselineInstallation',
      'baselineTransitiveOnly',
      'baselineVersionMatchesDesign',
      'baselineTargetVersionInstalled',
    ]) {
      if (typeof entry[field] !== 'boolean') {
        errors.push(`${entry.name}: ${field} 必须为 boolean`);
      }
    }
    if (!AUDIT_CATEGORIES.has(entry.baselineCategory)) {
      errors.push(`${entry.name}: 未知 baselineCategory ${String(entry.baselineCategory)}`);
    }
    if (
      entry.baselineCatalogSpec !== null &&
      (typeof entry.baselineCatalogSpec !== 'string' || entry.baselineCatalogSpec.length === 0)
    ) {
      errors.push(`${entry.name}: baselineCatalogSpec 必须为非空字符串或 null`);
    }
    if (
      !Array.isArray(entry.baselineLockVersions) ||
      !entry.baselineLockVersions.every((version) => typeof version === 'string')
    ) {
      errors.push(`${entry.name}: baselineLockVersions 必须为字符串数组`);
      continue;
    }
    if (new Set(entry.baselineLockVersions).size !== entry.baselineLockVersions.length) {
      errors.push(`${entry.name}: baselineLockVersions 不得重复`);
    }
    if (entry.baselineInstallation !== entry.baselineLockVersions.length > 0) {
      errors.push(`${entry.name}: baselineInstallation 与 lock versions 不一致`);
    }
    const expectedCategory = entry.baselineDeclaration
      ? entry.baselineInstallation
        ? 'DECLARED_INSTALLED'
        : 'DECLARED_NOT_INSTALLED'
      : entry.baselineInstallation
        ? 'UNDECLARED_INSTALLED'
        : 'UNDECLARED_NOT_INSTALLED';
    if (entry.baselineCategory !== expectedCategory) {
      errors.push(`${entry.name}: baselineCategory 与 declaration/installation 不一致`);
    }
    if (
      entry.baselineTransitiveOnly !== (!entry.baselineDeclaration && entry.baselineInstallation)
    ) {
      errors.push(`${entry.name}: baselineTransitiveOnly 与声明/安装状态不一致`);
    }
    if (
      entry.baselineTargetVersionInstalled !==
      entry.baselineLockVersions.includes(entry.designVersion)
    ) {
      errors.push(`${entry.name}: baselineTargetVersionInstalled 与 lock versions 不一致`);
    }
    if (
      entry.baselineVersionMatchesDesign !==
      (entry.baselineLockVersions.length > 0 &&
        entry.baselineLockVersions.every((version) => version === entry.designVersion))
    ) {
      errors.push(`${entry.name}: baselineVersionMatchesDesign 与 lock versions 不一致`);
    }
  }

  for (const name of ledgerByName.keys()) {
    if (!auditNames.has(name)) errors.push(`dependency audit 缺少 ${name}`);
  }
  for (const name of auditNames) {
    if (!ledgerByName.has(name)) errors.push(`dependency audit 出现账本外依赖 ${name}`);
  }

  const designAudit = audit.filter((entry) => DESIGN_DEPENDENCY_SOURCES.has(entry.source));
  for (const [category, expected] of AUDIT_CATEGORIES) {
    const actual = designAudit.filter((entry) => entry.baselineCategory === category).length;
    if (actual !== expected) {
      errors.push(`baselineCategory ${category} 应为 ${expected} 项，实际 ${actual}`);
    }
  }
  const declared = audit.filter((entry) => entry.baselineDeclaration);
  const installed = audit.filter((entry) => entry.baselineInstallation);
  const transitiveOnly = audit.filter((entry) => entry.baselineTransitiveOnly);
  if (declared.length !== 57) errors.push(`baseline 已声明应为 57 项，实际 ${declared.length}`);
  if (installed.length !== 67) errors.push(`baseline 已安装应为 67 项，实际 ${installed.length}`);
  if (transitiveOnly.length !== 15) {
    errors.push(`baseline 仅传递依赖应为 15 项，实际 ${transitiveOnly.length}`);
  }
  const transitiveNames = new Set(transitiveOnly.map((entry) => entry.name));
  for (const name of BASELINE_TRANSITIVE_ONLY) {
    if (!transitiveNames.has(name)) errors.push(`baseline 仅传递依赖缺少 ${name}`);
  }
  for (const name of transitiveNames) {
    if (!BASELINE_TRANSITIVE_ONLY.has(name)) errors.push(`${name}: 不在仅传递依赖白名单`);
  }
  const nonExactCatalogSpec = audit.filter(
    (entry) =>
      entry.baselineCatalogSpec !== null && entry.baselineCatalogSpec !== entry.designVersion,
  );
  if (nonExactCatalogSpec.length !== 26) {
    errors.push(`非设计精确 catalog spec 应为 26 项，实际 ${nonExactCatalogSpec.length}`);
  }
  const missingInstalledTarget = designAudit.filter(
    (entry) => entry.baselineInstallation && !entry.baselineTargetVersionInstalled,
  );
  if (missingInstalledTarget.length !== 10) {
    errors.push(`已安装但缺失设计目标版本应为 10 项，实际 ${missingInstalledTarget.length}`);
  }
  for (const name of EXPECTED_TEST_ONLY.keys()) {
    const entry = audit.find((candidate) => candidate.name === name);
    if (entry === undefined) {
      errors.push(`dependency audit 缺少 test-only 项 ${name}`);
      continue;
    }
    if (
      entry.baselineDeclaration ||
      entry.baselineInstallation ||
      entry.baselineTransitiveOnly ||
      entry.baselineCatalogSpec !== null ||
      entry.baselineLockVersions.length > 0 ||
      entry.baselineVersionMatchesDesign ||
      entry.baselineTargetVersionInstalled ||
      entry.baselineCategory !== 'UNDECLARED_NOT_INSTALLED'
    ) {
      errors.push(`${name}: test-only 基线状态必须为未声明且未安装`);
    }
  }
  return errors;
}

function auditLicenses(model) {
  const whitelist = new Set(NPM_LICENSE_WHITELIST);
  const blockers = [];
  const releaseBlockers = [];
  const normalized = [];
  const devAudit = [];

  for (const entry of model.licenseEntries) {
    const pending = findPendingException(entry.name, entry.version);
    const normalizedLicense =
      NORMALIZED_DECLARED_LICENSES.get(`${entry.name}@${entry.version}`) ?? entry.normalized;
    const evaluation = evaluateLicense(normalizedLicense, whitelist);
    const record = {
      id: `${entry.name}@${entry.version}`,
      license: normalizedLicense,
      declared: entry.declared,
      parentChain: entry.parentChain,
      scope: entry.scope,
    };

    if (entry.scope !== 'production') {
      if (!evaluation.approved && pending === undefined) devAudit.push(record);
      continue;
    }

    if (pending !== undefined) {
      if (pending.releaseBlocking) {
        releaseBlockers.push({ ...record, status: pending.status, expression: pending.expression });
      }
      continue;
    }

    if (!evaluation.approved) {
      blockers.push({ ...record, kind: evaluation.kind });
      continue;
    }
    if (evaluation.kind !== 'single' || entry.resolution !== 'declared') {
      normalized.push({
        id: record.id,
        declared: entry.declared,
        resolved: evaluation.selected ?? entry.normalized,
        resolution: entry.resolution,
      });
    }
  }

  return { blockers, releaseBlockers, normalized, devAudit };
}

function checkImageLicenses(model) {
  const allowed = new Map(IMAGE_LICENSE_WHITELIST.map((entry) => [entry.service, entry.license]));
  const violations = [];
  for (const image of model.imageComponents) {
    const service = image.name.replace(/^image:/, '');
    const expected = allowed.get(service);
    const actual = image.properties.find((property) => property.name === 'kb:license')?.value;
    if (expected === undefined) violations.push(`${service}: 未登记容器镜像许可证`);
    else if (expected !== actual) violations.push(`${service}: 期望 ${expected}，实际 ${actual}`);
  }
  return violations;
}

function computeSbomDiff(repoRoot, model) {
  const baselinePath = join(repoRoot, 'artifacts', 'sbom.json');
  if (!existsSync(baselinePath)) return { baseline: 'missing', added: [], removed: [] };
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    return { baseline: 'unreadable', added: [], removed: [] };
  }
  const toKey = (component) => `${component.name}@${component.version}`;
  const before = new Set((baseline.components ?? []).map(toKey));
  const after = new Set(
    [
      ...(model.directComponents ?? []),
      ...(model.transitiveComponents ?? []),
      ...model.workspaceComponents,
      ...model.imageComponents,
    ].map(toKey),
  );
  return {
    baseline: relative(repoRoot, baselinePath),
    added: [...after].filter((key) => !before.has(key)).sort(),
    removed: [...before].filter((key) => !after.has(key)).sort(),
  };
}

export function parseDependencyCheckArgs(argv) {
  const options = { dependencyOnly: false, root: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dependency-only') {
      options.dependencyOnly = true;
      continue;
    }
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root 需要目录参数');
      options.root = value;
      index += 1;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseDependencyCheckArgs(argv);
  const repoRoot = options.root ? resolve(options.root) : resolve(import.meta.dirname, '..');
  const catalog = parseCatalog(readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
  const { errors, workspaceCount, manifests } = checkRegistrations(repoRoot, catalog);
  errors.push(
    ...checkDependencyBaseline(repoRoot, catalog, manifests, {
      skipInstallationChecks: options.dependencyOnly,
    }),
  );
  errors.push(...checkDependencyAudit(repoRoot));

  if (options.dependencyOnly) {
    if (errors.length > 0) {
      console.error(`dependency gate 失败，共 ${errors.length} 项：`);
      for (const error of errors) console.error(`  - ${error}`);
      process.exit(1);
    }
    console.log(
      `dependency gate 通过：166 项 ledger、166 项 audit、160 项 catalog、` +
        `${workspaceCount} 个 workspace 包。`,
    );
    return;
  }

  const { collectSbomModel } = await import('./generate-sbom.mjs');
  const model = collectSbomModel(repoRoot);
  const { blockers, releaseBlockers, normalized, devAudit } = auditLicenses(model);
  errors.push(...checkImageLicenses(model).map((violation) => `镜像许可证: ${violation}`));
  errors.push(
    ...blockers.map(
      (blocker) =>
        `未批准生产依赖: ${blocker.id} license=${blocker.license} (${blocker.kind}) ← ${blocker.parentChain}`,
    ),
  );

  const diff = computeSbomDiff(repoRoot, model);
  const productionCount = model.licenseEntries.filter(
    (entry) => entry.scope === 'production',
  ).length;

  if (errors.length > 0) {
    console.error(`license:check 失败，共 ${errors.length} 项：`);
    for (const error of errors) console.error(`  - ${error}`);
    for (const blocker of releaseBlockers) {
      console.error(
        `  - RELEASE BLOCKER ${blocker.id} (${blocker.license}) ${blocker.parentChain}`,
      );
    }
    process.exit(1);
  }

  console.log(
    `license:check 通过：${workspaceCount} 个 workspace 包，${catalog.size} 个 catalog 登记项；` +
      `生产闭包 ${productionCount} 个 npm 组件。`,
  );
  const normalizedText = normalized
    .map((entry) => `${entry.id} (${entry.declared} → ${entry.resolved}, ${entry.resolution})`)
    .join('；');
  if (normalizedText.length > 0) console.log(`SPDX/文本规范化通过：${normalizedText}`);
  if (devAudit.length > 0) {
    console.log(
      `dev/build-only 非阻塞审计（${devAudit.length} 条）：` +
        devAudit.map((entry) => `${entry.id} (${entry.declared})`).join('；'),
    );
  }
  if (diff.baseline === 'missing') {
    console.log('SBOM diff：无既有 artifacts/sbom.json 基线（CI 干净检出场景）。');
  } else if (diff.added.length === 0 && diff.removed.length === 0) {
    console.log(`SBOM diff：与 ${diff.baseline} 组件集合一致。`);
  } else {
    console.log(
      `SBOM diff：baseline=${diff.baseline} added=${diff.added.length} removed=${diff.removed.length}`,
    );
  }

  if (releaseBlockers.length > 0) {
    console.log(
      `RELEASE BLOCKER（pending-legal-review，${releaseBlockers.length} 条；阻断发布、不阻断 CI）：`,
    );
    for (const blocker of releaseBlockers) {
      console.log(`  - ${blocker.id} | ${blocker.license} | ${blocker.parentChain}`);
    }
    console.log('详见 NOTICE 与 docs/runbooks/release.md 的发布阻塞项。');
  }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  // 不使用顶层 await：generate-sbom.mjs 会静态 import 本模块的声明，
  // 顶层 await 会在该循环上死锁（ERR_AMBIGUOUS_MODULE_SYNTAX / unsettled TLA）。
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
