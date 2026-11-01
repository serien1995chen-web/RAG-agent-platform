import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  S11_CROSS_TEST_IDS,
  S11_DEFERRED_CAPABILITY_IDS,
  S11_EXCLUDED_IDS,
  S11_SCOPE_PROFILE,
  buildTemplateRows,
  developmentTestIds,
  scopedDevelopmentTestIds,
  scopeCounts,
} from '../../scripts/lib/s11-capability.mjs';
import {
  EXCLUDED_GUARDS,
  EXPECTED_33_CROSS_IDS,
  EXPECTED_69_IDS,
  parseMatrix,
  validateTemplate,
} from '../../scripts/validate-s11-report.mjs';

const root = resolve(import.meta.dirname, '../..');

describe('TEST-X-S11-CAPABILITY-MATRIX / TEST-X-S11-EVIDENCE-BINDING', () => {
  it('contains exactly 73 unique rows, 69 development and 4 excluded', () => {
    const text = readFileSync(join(root, 'docs', 'acceptance', 's11-capability-matrix.md'), 'utf8');
    const result = validateTemplate(text);
    expect(result.errors).toEqual([]);
    expect(result.rows).toBe(73);
    expect(new Set(result.ids).size).toBe(73);
    expect(result.ids.filter((id) => S11_EXCLUDED_IDS.includes(id))).toEqual([
      'KB-004',
      'ING-010',
      'MULTI-002',
      'MULTI-003',
    ]);
  });

  it('keeps the 69 blocking test IDs and 33 cross-cutting IDs complete', () => {
    expect(developmentTestIds(root)).toHaveLength(69);
    expect(EXPECTED_69_IDS).toHaveLength(69);
    expect(EXPECTED_33_CROSS_IDS).toHaveLength(33);
    expect(S11_CROSS_TEST_IDS).toHaveLength(33);
    expect(EXCLUDED_GUARDS).toEqual([
      'TEST-EXCLUDED-KB-004',
      'TEST-EXCLUDED-ING-010',
      'TEST-EXCLUDED-MULTI-002',
      'TEST-EXCLUDED-MULTI-003',
    ]);
  });

  it('keeps the phase1 matrix free of PASS and machine-readable', () => {
    const rows = buildTemplateRows(root);
    expect(rows).toHaveLength(73);
    expect(rows.filter((row) => row.status === 'NOT_RUN')).toHaveLength(69);
    expect(rows.filter((row) => row.status === 'EXCLUDED')).toHaveLength(4);
    expect(rows.some((row) => row.status === 'PASS')).toBe(false);
    expect(
      parseMatrix(
        readFileSync(join(root, 'docs', 'acceptance', 's11-capability-matrix.md'), 'utf8'),
      ),
    ).toHaveLength(73);
  });

  it('applies the knowledge-usability-v1 scope without mutating canonical rows', () => {
    const rows = buildTemplateRows(root, S11_SCOPE_PROFILE);
    const counts = scopeCounts(root, S11_SCOPE_PROFILE);
    expect(rows).toHaveLength(73);
    expect(rows.filter((row) => row.status === 'NOT_RUN')).toHaveLength(66);
    expect(rows.filter((row) => row.status === 'DEFERRED_BY_SCOPE')).toHaveLength(3);
    expect(rows.filter((row) => row.status === 'EXCLUDED')).toHaveLength(4);
    expect(
      rows.filter((row) => row.status === 'DEFERRED_BY_SCOPE').map((row) => row.capability),
    ).toEqual(S11_DEFERRED_CAPABILITY_IDS);
    expect(scopedDevelopmentTestIds(root)).toHaveLength(66);
    expect(counts).toMatchObject({
      total: 73,
      base: 12,
      data: 57,
      excluded: 4,
      canonicalDevelopment: 69,
      deferred: 3,
      inScopeDevelopment: 66,
      inScopeData: 54,
    });
  });
});
