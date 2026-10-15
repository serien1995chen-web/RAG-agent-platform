#!/usr/bin/env node
/**
 * 依赖登记与许可证门禁（设计文档 6.2 / 6.3 / 18.10 / ADR-019；N6-A 裁决）。
 *
 * 检查项：
 * 1. 既有三项不削弱：catalog: 已登记 / workspace: 指向存在包 / 禁止 latest、*。
 * 2. npm 生产闭包白名单：SPDX OR 命中任一白名单分支即通过并记录所选分支；
 *    AND 要求全部分支命中；裸 BSD 读取包内 LICENSE 文本归一化为 BSD-2/3-Clause。
 * 3. N6-A `PENDING_LEGAL_REVIEW` 例外表（精确 name@version，仅 3 条）：
 *    命中即退出 0，但必须输出 `RELEASE BLOCKER`，并登记到 NOTICE 与 release.md。
 * 4. 容器镜像白名单单独一套（与 npm 清单分开）。
 * 5. dev/build-only 白名单外许可证记非阻塞审计，不阻断。
 * 6. SBOM diff：与既有 artifacts/sbom.json 比对组件集合差异（新增/移除）。
 *
 * 模块被 import 时不产生副作用（generate-sbom.mjs 复用同一份声明）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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
];

/**
 * N6-A 生产闭包例外表：只登记 3 条待法务复核项。
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
];

/** 容器镜像白名单（与 npm 包白名单分开登记）。 */
export const IMAGE_LICENSE_WHITELIST = [
  { service: 'mongo', license: 'SSPL', confirmedBy: '设计 6.2' },
  { service: 'redis', license: 'RSAL/SSPL', confirmedBy: '设计 6.2' },
  { service: 'minio', license: 'AGPL-3.0', confirmedBy: '设计 6.2' },
  { service: 'pgvector', license: 'PostgreSQL', confirmedBy: 'N2-A 用户确认' },
];

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

/** 既有三项检查（不得削弱）：catalog 登记 / workspace 引用 / 禁止 latest、*。 */
function checkRegistrations(repoRoot, catalog) {
  const errors = [];
  const workspaceNames = new Set();
  const packages = [];

  for (const dir of ['packages', 'projects', 'sdk']) {
    for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(repoRoot, dir, entry.name, 'package.json');
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
    const rel = relative(repoRoot, manifestPath);
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

  return { errors, packageCount: packages.length };
}

function auditLicenses(model) {
  const whitelist = new Set(NPM_LICENSE_WHITELIST);
  const blockers = [];
  const releaseBlockers = [];
  const normalized = [];
  const devAudit = [];

  for (const entry of model.licenseEntries) {
    const pending = findPendingException(entry.name, entry.version);
    const evaluation = evaluateLicense(entry.normalized, whitelist);
    const record = {
      id: `${entry.name}@${entry.version}`,
      license: entry.normalized,
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

export async function main() {
  const repoRoot = resolve(import.meta.dirname, '..');
  const catalog = parseCatalog(readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
  const { errors, packageCount } = checkRegistrations(repoRoot, catalog);

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
    `license:check 通过：${packageCount} 个 workspace 包，${catalog.size} 个 catalog 登记项；` +
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
