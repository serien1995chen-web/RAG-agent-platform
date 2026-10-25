import { describe, expect, it } from 'vitest';
import {
  DEPENDENCY_OWNER_STAGE_COUNTS,
  NPM_DEPENDENCY_BASELINE,
  validateDependencyCatalog,
  validateDependencyLedger,
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
        entry.name === 'ajv' ||
        entry.name === '@llamaindex/liteparse-wasm',
    ).map((entry) => [entry.name, entry.version]),
  );
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
    expect(
      NPM_DEPENDENCY_BASELINE.find((entry) => entry.name === '@llamaindex/liteparse-wasm')
        ?.ownerStage,
    ).toBe('S5');
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
