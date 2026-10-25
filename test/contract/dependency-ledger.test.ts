import { describe, expect, it } from 'vitest';
import {
  DEPENDENCY_LEDGER_TOTALS,
  DEPENDENCY_OWNER_STAGE_COUNTS,
  NPM_DEPENDENCY_AUDIT,
  NPM_DEPENDENCY_BASELINE,
  validateDependencyAudit,
  validateDependencyCatalog,
  validateDependencyLedger,
  type DependencyAuditEntry,
  type DependencyLedgerEntry,
} from '../../packages/contracts/src/dependencies/dependency-ledger';

function mutableLedger(): DependencyLedgerEntry[] {
  return structuredClone(NPM_DEPENDENCY_BASELINE) as DependencyLedgerEntry[];
}

function realCatalog(): Map<string, string> {
  return new Map(
    NPM_DEPENDENCY_BASELINE.filter(
      (entry) =>
        entry.ownerStage === 'S1' ||
        entry.ownerStage === 'S2' ||
        entry.name === 'ajv' ||
        entry.name === '@llamaindex/liteparse-wasm',
    ).map((entry) => [entry.name, entry.version]),
  );
}

function mutableAudit(): DependencyAuditEntry[] {
  return structuredClone(NPM_DEPENDENCY_AUDIT) as DependencyAuditEntry[];
}

describe('npm dependency ledger', () => {
  it('contains 166 unique entries, 164 design entries and 2 approved test-only entries', () => {
    expect(NPM_DEPENDENCY_BASELINE).toHaveLength(166);
    expect(new Set(NPM_DEPENDENCY_BASELINE.map((entry) => entry.name)).size).toBe(166);
    expect(
      NPM_DEPENDENCY_BASELINE.filter((entry) => entry.source === 'USER_APPROVED_S1_BROWSER_E2E'),
    ).toHaveLength(2);
    expect(validateDependencyLedger()).toEqual([]);
  });

  it('matches the frozen ownerStage counts and catalog exceptions', () => {
    const counts = Object.fromEntries(
      Object.keys(DEPENDENCY_OWNER_STAGE_COUNTS).map((stage) => [
        stage,
        NPM_DEPENDENCY_BASELINE.filter(
          (entry) => entry.source !== 'USER_APPROVED_S1_BROWSER_E2E' && entry.ownerStage === stage,
        ).length,
      ]),
    );
    expect(counts).toEqual(DEPENDENCY_OWNER_STAGE_COUNTS);
    expect(NPM_DEPENDENCY_BASELINE.find((entry) => entry.name === 'ajv')?.ownerStage).toBe('S4');
    expect(DEPENDENCY_LEDGER_TOTALS.catalog).toBe(108);
    expect(NPM_DEPENDENCY_BASELINE.filter((entry) => entry.ownerStage === 'S2')).toHaveLength(13);
    expect(
      NPM_DEPENDENCY_BASELINE.find((entry) => entry.name === '@llamaindex/liteparse-wasm')
        ?.ownerStage,
    ).toBe('S5');
  });

  it('matches all S1, S2 and catalog-only entries in the catalog', () => {
    expect(validateDependencyCatalog(NPM_DEPENDENCY_BASELINE, realCatalog())).toEqual([]);
  });

  it('rejects duplicate names', () => {
    const entries = mutableLedger();
    entries[1] = structuredClone(entries[0]!);
    expect(validateDependencyLedger(entries).join('\n')).toContain('名称重复');
  });

  it('rejects missing entries', () => {
    expect(validateDependencyLedger(mutableLedger().slice(0, -1)).join('\n')).toContain(
      '应为 166 项',
    );
  });

  it('rejects range versions', () => {
    const entries = mutableLedger();
    entries[0] = { ...entries[0]!, version: '^1.0.0' };
    expect(validateDependencyLedger(entries).join('\n')).toContain('必须为精确版本');
  });

  it('rejects unknown owner stages', () => {
    const entries = mutableLedger();
    entries[0] = {
      ...entries[0]!,
      ownerStage: 'S99' as DependencyLedgerEntry['ownerStage'],
    };
    expect(validateDependencyLedger(entries).join('\n')).toContain('未知 ownerStage');
  });

  it('rejects unauthorized supplement sources', () => {
    const entries = mutableLedger();
    entries[0] = {
      ...entries[0]!,
      source: 'USER_APPROVED_S1_BROWSER_E2E',
    };
    expect(validateDependencyLedger(entries).join('\n')).toContain('未授权此项');
  });

  it('rejects version drift against the catalog', () => {
    const catalog = realCatalog();
    const first = [...catalog.keys()][0]!;
    catalog.set(first, '0.0.0');
    expect(validateDependencyCatalog(NPM_DEPENDENCY_BASELINE, catalog).join('\n')).toContain(
      'catalog 版本漂移',
    );
  });
});

describe('npm dependency baseline audit', () => {
  it('matches the frozen baseline state and 52/5/15/92 classification', () => {
    expect(NPM_DEPENDENCY_AUDIT).toHaveLength(166);
    expect(validateDependencyAudit()).toEqual([]);
    expect(
      NPM_DEPENDENCY_AUDIT.filter((entry) => entry.baselineCategory === 'DECLARED_INSTALLED'),
    ).toHaveLength(52);
    expect(
      NPM_DEPENDENCY_AUDIT.filter((entry) => entry.baselineCategory === 'DECLARED_NOT_INSTALLED'),
    ).toHaveLength(5);
    expect(NPM_DEPENDENCY_AUDIT.filter((entry) => entry.baselineTransitiveOnly)).toHaveLength(15);
  });

  it('rejects a missing or duplicate audit entry', () => {
    const missing = mutableAudit().slice(0, -1);
    expect(validateDependencyAudit(missing).join('\n')).toContain('应为 166 项');

    const duplicate = mutableAudit();
    duplicate[1] = structuredClone(duplicate[0]!);
    expect(validateDependencyAudit(duplicate).join('\n')).toContain('名称重复');
  });

  it('rejects category and derived-state drift', () => {
    const entries = mutableAudit();
    const installed = entries.find((entry) => entry.baselineCategory === 'DECLARED_INSTALLED')!;
    Object.assign(installed, {
      baselineCategory: 'UNDECLARED_NOT_INSTALLED',
    });
    const errors = validateDependencyAudit(entries).join('\n');
    expect(errors).toContain('baselineCategory 与 declaration/installation 不一致');
    expect(errors).toContain('baselineCategory DECLARED_INSTALLED');
  });

  it('rejects transitive-only list drift and test-only activation', () => {
    const entries = mutableAudit();
    const transitive = entries.find((entry) => entry.baselineTransitiveOnly)!;
    transitive.baselineTransitiveOnly = false;
    const testOnly = entries.find((entry) => entry.name === '@playwright/test')!;
    testOnly.baselineDeclaration = true;
    const errors = validateDependencyAudit(entries).join('\n');
    expect(errors).toContain('仅传递依赖');
    expect(errors).toContain('test-only 基线状态必须为未声明且未安装');
  });

  it('rejects ownerStage or source drift from the ledger', () => {
    const entries = mutableAudit();
    entries[0] = {
      ...entries[0]!,
      ownerStage: 'S11',
    };
    expect(validateDependencyAudit(entries).join('\n')).toContain(
      'audit ownerStage 与 ledger 不一致',
    );
  });
});
