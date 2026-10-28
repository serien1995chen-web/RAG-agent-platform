import rawDependencyLedger from './npm-dependency-baseline.data.json';
import rawDependencyAudit from './npm-dependency-audit.data.json';

export const DEPENDENCY_SOURCES = [
  'PROJECT_BASELINE',
  'FASTGPT_SUPPLEMENT',
  'USER_APPROVED_S1_BROWSER_E2E',
] as const;
export type DependencySource = (typeof DEPENDENCY_SOURCES)[number];

export const DEPENDENCY_STAGES = [
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
] as const;
export type DependencyStage = (typeof DEPENDENCY_STAGES)[number];

export const DEPENDENCY_SCOPES = ['RUNTIME', 'BUILD', 'TEST_ONLY'] as const;
export type DependencyScope = (typeof DEPENDENCY_SCOPES)[number];

export const DEPENDENCY_AUDIT_CATEGORIES = [
  'DECLARED_INSTALLED',
  'DECLARED_NOT_INSTALLED',
  'UNDECLARED_INSTALLED',
  'UNDECLARED_NOT_INSTALLED',
] as const;
export type DependencyAuditCategory = (typeof DEPENDENCY_AUDIT_CATEGORIES)[number];

export interface DependencyLedgerEntry {
  name: string;
  version: string;
  source: DependencySource;
  ownerStage: DependencyStage;
  scope: DependencyScope;
  environments: string[];
  usage: string[];
}

export interface DependencyAuditEntry {
  name: string;
  designVersion: string;
  ownerStage: DependencyStage;
  source: DependencySource;
  baselineDeclaration: boolean;
  baselineInstallation: boolean;
  baselineTransitiveOnly: boolean;
  baselineCategory: DependencyAuditCategory;
  baselineCatalogSpec: string | null;
  baselineLockVersions: string[];
  baselineVersionMatchesDesign: boolean;
  baselineTargetVersionInstalled: boolean;
}

export const DEPENDENCY_LEDGER_TOTALS = {
  total: 166,
  design: 164,
  testOnlySupplements: 2,
  catalog: 138,
} as const;

export const DEPENDENCY_OWNER_STAGE_COUNTS: Readonly<Record<DependencyStage, number>> = {
  S1: 91,
  S2: 13,
  S3: 0,
  S4: 24,
  S5: 2,
  S6: 6,
  S7: 21,
  S8: 1,
  S9: 0,
  S10: 6,
  S11: 0,
};

export const APPROVED_TEST_ONLY_DEPENDENCIES = [
  {
    name: '@playwright/test',
    version: '1.64.1',
    usage: ['browser-e2e'],
  },
  {
    name: '@axe-core/playwright',
    version: '4.14.0',
    usage: ['accessibility-e2e'],
  },
] as const;

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

const BASELINE_DESIGN_CATEGORY_COUNTS: Readonly<Record<DependencyAuditCategory, number>> = {
  DECLARED_INSTALLED: 52,
  DECLARED_NOT_INSTALLED: 5,
  UNDECLARED_INSTALLED: 15,
  UNDECLARED_NOT_INSTALLED: 92,
};

const CATALOG_ONLY_LATER_STAGE_DEPENDENCIES = new Set([
  'ajv',
  '@llamaindex/liteparse-wasm',
  '@types/turndown',
]);
const CATALOG_DECLARED_STAGES = new Set<DependencyStage>(['S1', 'S2', 'S4', 'S6']);

const ALLOWED_ENVIRONMENTS = new Set([
  'APP_RUNTIME',
  'WORKER_RUNTIME',
  'BROWSER_RUNTIME',
  'BUILD',
  'TEST',
]);

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const FORBIDDEN_PACKAGE = /^@fastgpt-|^@fastgpt-sdk\/|^@kb-sdk\//;
const DESIGN_SOURCES = new Set<DependencySource>(['PROJECT_BASELINE', 'FASTGPT_SUPPLEMENT']);

export const NPM_DEPENDENCY_BASELINE =
  rawDependencyLedger as unknown as readonly DependencyLedgerEntry[];
export const NPM_DEPENDENCY_AUDIT =
  rawDependencyAudit as unknown as readonly DependencyAuditEntry[];

function hasOnlyStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}

function isDesignEntry(entry: DependencyLedgerEntry): boolean {
  return DESIGN_SOURCES.has(entry.source);
}

export function validateDependencyLedger(
  entries: readonly DependencyLedgerEntry[] = NPM_DEPENDENCY_BASELINE,
): string[] {
  const errors: string[] = [];
  const names = new Set<string>();

  if (entries.length !== DEPENDENCY_LEDGER_TOTALS.total) {
    errors.push(
      `dependency ledger 应为 ${DEPENDENCY_LEDGER_TOTALS.total} 项，实际 ${entries.length} 项`,
    );
  }

  for (const [index, entry] of entries.entries()) {
    if (typeof entry?.name !== 'string' || entry.name.trim().length === 0) {
      errors.push(`dependency ledger[${index}] 缺少 name`);
      continue;
    }
    if (names.has(entry.name)) errors.push(`dependency ledger 名称重复: ${entry.name}`);
    names.add(entry.name);

    if (!EXACT_VERSION.test(entry.version)) {
      errors.push(`${entry.name}: version 必须为精确版本，实际 ${entry.version}`);
    }
    if (FORBIDDEN_PACKAGE.test(entry.name)) {
      errors.push(`${entry.name}: 禁止依赖`);
    }
    if (!DEPENDENCY_SOURCES.includes(entry.source)) {
      errors.push(`${entry.name}: 未知 source ${String(entry.source)}`);
    }
    if (!DEPENDENCY_STAGES.includes(entry.ownerStage)) {
      errors.push(`${entry.name}: 未知 ownerStage ${String(entry.ownerStage)}`);
    }
    if (!DEPENDENCY_SCOPES.includes(entry.scope)) {
      errors.push(`${entry.name}: 未知 scope ${String(entry.scope)}`);
    }
    if (!hasOnlyStrings(entry.environments)) {
      errors.push(`${entry.name}: environments 必须是非空字符串数组`);
    } else {
      for (const environment of entry.environments) {
        if (!ALLOWED_ENVIRONMENTS.has(environment)) {
          errors.push(`${entry.name}: 未知 environment ${environment}`);
        }
      }
    }
    if (!hasOnlyStrings(entry.usage)) {
      errors.push(`${entry.name}: usage 必须是非空字符串数组`);
    }
  }

  const designEntries = entries.filter(isDesignEntry);
  const supplementEntries = entries.filter(
    (entry) => entry.source === 'USER_APPROVED_S1_BROWSER_E2E',
  );
  if (designEntries.length !== DEPENDENCY_LEDGER_TOTALS.design) {
    errors.push(
      `设计依赖应为 ${DEPENDENCY_LEDGER_TOTALS.design} 项，实际 ${designEntries.length} 项`,
    );
  }
  if (supplementEntries.length !== DEPENDENCY_LEDGER_TOTALS.testOnlySupplements) {
    errors.push(
      `test-only 补充项应为 ${DEPENDENCY_LEDGER_TOTALS.testOnlySupplements} 项，实际 ${supplementEntries.length} 项`,
    );
  }

  const stageCounts = new Map<DependencyStage, number>(
    DEPENDENCY_STAGES.map((stage) => [stage, 0]),
  );
  for (const entry of designEntries) {
    if (DEPENDENCY_STAGES.includes(entry.ownerStage)) {
      stageCounts.set(entry.ownerStage, (stageCounts.get(entry.ownerStage) ?? 0) + 1);
    }
  }
  for (const stage of DEPENDENCY_STAGES) {
    const expected = DEPENDENCY_OWNER_STAGE_COUNTS[stage];
    const actual = stageCounts.get(stage) ?? 0;
    if (actual !== expected) {
      errors.push(`ownerStage ${stage} 应为 ${expected} 项，实际 ${actual} 项`);
    }
  }

  for (const approved of APPROVED_TEST_ONLY_DEPENDENCIES) {
    const matches = supplementEntries.filter((entry) => entry.name === approved.name);
    if (matches.length !== 1) {
      errors.push(`${approved.name}: test-only 授权项必须唯一存在`);
      continue;
    }
    const [entry] = matches;
    if (entry === undefined) continue;
    if (entry.version !== approved.version) {
      errors.push(`${entry.name}: test-only 版本应为 ${approved.version}，实际 ${entry.version}`);
    }
    if (entry.ownerStage !== 'S1' || entry.scope !== 'TEST_ONLY') {
      errors.push(`${entry.name}: test-only 必须归属 S1 且 scope 为 TEST_ONLY`);
    }
    if (entry.environments.length !== 1 || entry.environments[0] !== 'TEST') {
      errors.push(`${entry.name}: test-only 只允许 TEST environment`);
    }
    if (JSON.stringify(entry.usage) !== JSON.stringify(approved.usage)) {
      errors.push(`${entry.name}: test-only usage 与授权不一致`);
    }
  }

  for (const entry of supplementEntries) {
    if (!APPROVED_TEST_ONLY_DEPENDENCIES.some((approved) => approved.name === entry.name)) {
      errors.push(`${entry.name}: USER_APPROVED_S1_BROWSER_E2E 未授权此项`);
    }
  }

  for (const entry of entries) {
    if (
      (entry.name === 'ajv' && entry.ownerStage !== 'S4') ||
      (entry.name === '@llamaindex/liteparse-wasm' && entry.ownerStage !== 'S5') ||
      (entry.name === '@types/turndown' && entry.ownerStage !== 'S5')
    ) {
      errors.push(`${entry.name}: catalog-only 阶段归属错误`);
    }
  }

  return errors;
}

function expectedAuditCategory(declared: boolean, installed: boolean): DependencyAuditCategory {
  if (declared) return installed ? 'DECLARED_INSTALLED' : 'DECLARED_NOT_INSTALLED';
  return installed ? 'UNDECLARED_INSTALLED' : 'UNDECLARED_NOT_INSTALLED';
}

export function validateDependencyAudit(
  audit: readonly DependencyAuditEntry[] = NPM_DEPENDENCY_AUDIT,
  ledger: readonly DependencyLedgerEntry[] = NPM_DEPENDENCY_BASELINE,
): string[] {
  const errors: string[] = [];
  const auditNames = new Set<string>();
  const ledgerByName = new Map(ledger.map((entry) => [entry.name, entry]));

  if (audit.length !== DEPENDENCY_LEDGER_TOTALS.total) {
    errors.push(
      `dependency audit 应为 ${DEPENDENCY_LEDGER_TOTALS.total} 项，实际 ${audit.length} 项`,
    );
  }

  for (const [index, entry] of audit.entries()) {
    if (typeof entry?.name !== 'string' || entry.name.trim().length === 0) {
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
        errors.push(
          `${entry.name}: audit designVersion ${entry.designVersion} 与 ledger ${ledgerEntry.version} 不一致`,
        );
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
    ] as const) {
      if (typeof entry[field] !== 'boolean') {
        errors.push(`${entry.name}: ${field} 必须为 boolean`);
      }
    }
    if (!DEPENDENCY_AUDIT_CATEGORIES.includes(entry.baselineCategory)) {
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
    if (
      entry.baselineCategory !==
      expectedAuditCategory(entry.baselineDeclaration, entry.baselineInstallation)
    ) {
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

  const designAudit = audit.filter(
    (entry) => entry.source === 'PROJECT_BASELINE' || entry.source === 'FASTGPT_SUPPLEMENT',
  );
  for (const category of DEPENDENCY_AUDIT_CATEGORIES) {
    const actual = designAudit.filter((entry) => entry.baselineCategory === category).length;
    const expected = BASELINE_DESIGN_CATEGORY_COUNTS[category];
    if (actual !== expected) {
      errors.push(`baselineCategory ${category} 应为 ${expected} 项，实际 ${actual} 项`);
    }
  }

  const declared = audit.filter((entry) => entry.baselineDeclaration);
  const installed = audit.filter((entry) => entry.baselineInstallation);
  const transitiveOnly = audit.filter((entry) => entry.baselineTransitiveOnly);
  if (declared.length !== 57) errors.push(`baseline 已声明应为 57 项，实际 ${declared.length} 项`);
  if (installed.length !== 67)
    errors.push(`baseline 已安装应为 67 项，实际 ${installed.length} 项`);
  if (transitiveOnly.length !== 15) {
    errors.push(`baseline 仅传递依赖应为 15 项，实际 ${transitiveOnly.length} 项`);
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
    errors.push(`非设计精确 catalog spec 应为 26 项，实际 ${nonExactCatalogSpec.length} 项`);
  }
  const missingInstalledTarget = designAudit.filter(
    (entry) => entry.baselineInstallation && !entry.baselineTargetVersionInstalled,
  );
  if (missingInstalledTarget.length !== 10) {
    errors.push(`已安装但缺失设计目标版本应为 10 项，实际 ${missingInstalledTarget.length} 项`);
  }

  for (const approved of APPROVED_TEST_ONLY_DEPENDENCIES) {
    const entry = audit.find((candidate) => candidate.name === approved.name);
    if (!entry) {
      errors.push(`dependency audit 缺少 test-only 项 ${approved.name}`);
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
      errors.push(`${approved.name}: test-only 基线状态必须为未声明且未安装`);
    }
  }

  return errors;
}

export function validateDependencyCatalog(
  entries: readonly DependencyLedgerEntry[],
  catalog: ReadonlyMap<string, string>,
): string[] {
  const errors: string[] = [];
  const expected = new Map(
    entries
      .filter(
        (entry) =>
          CATALOG_DECLARED_STAGES.has(entry.ownerStage) ||
          CATALOG_ONLY_LATER_STAGE_DEPENDENCIES.has(entry.name),
      )
      .map((entry) => [entry.name, entry.version]),
  );

  if (expected.size !== DEPENDENCY_LEDGER_TOTALS.catalog) {
    errors.push(
      `catalog 期望项应为 ${DEPENDENCY_LEDGER_TOTALS.catalog}，账本计算为 ${expected.size}`,
    );
  }
  if (catalog.size !== DEPENDENCY_LEDGER_TOTALS.catalog) {
    errors.push(`catalog 应为 ${DEPENDENCY_LEDGER_TOTALS.catalog} 项，实际 ${catalog.size} 项`);
  }
  for (const [name, version] of expected) {
    const actual = catalog.get(name);
    if (actual === undefined) errors.push(`catalog 缺少 ${name}@${version}`);
    else if (actual !== version) {
      errors.push(`${name}: catalog 版本漂移，期望 ${version}，实际 ${actual}`);
    }
  }
  for (const name of catalog.keys()) {
    if (!expected.has(name)) errors.push(`catalog 出现未登记依赖 ${name}`);
  }

  return errors;
}
