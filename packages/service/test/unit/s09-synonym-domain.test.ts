import { describe, expect, it } from 'vitest';
import {
  SYNONYM_LIMITS,
  codePointLength,
  normalizeTerm,
  stableLogicalIds,
  validateMappings,
  type SynonymInputRow,
} from '../../src/modules/knowledge/domain/s09-synonym';

function row(rowNumber: number, values: readonly string[]): SynonymInputRow {
  return {
    rowNumber,
    cells: values.map((value, index) => ({ columnNumber: index + 1, value })),
  };
}

function rows(...values: Array<readonly string[]>): SynonymInputRow[] {
  return values.map((value, index) => row(index + 1, value));
}

function codes(result: ReturnType<typeof validateMappings>): string[] {
  return result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code);
}

describe('S9 synonym domain validation', () => {
  it('TEST-SEARCH-003-BLOCK normalizes ASCII case only and preserves Unicode', () => {
    expect(normalizeTerm('  ABC ÄBC 内部  空白  ')).toBe('abc Äbc 内部  空白');
    expect(codePointLength('😀a')).toBe(2);
  });

  it('TEST-SEARCH-003-BLOCK validates headers and produces deterministic mappings', () => {
    const result = validateMappings(
      rows(
        ['standardizedTerm', 'synonymTerms2', 'SYNONYM1'],
        ['Refund', '返还', '退货'],
        ['refund', '退款', '退货2'],
        ['Delivery', '配送', '发货'],
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mappings).toHaveLength(2);
    const refund = result.mappings.find(
      (mapping) => mapping.normalizedStandardizedTerm === 'refund',
    );
    expect(refund).toMatchObject({
      standardizedTerm: 'Refund',
      normalizedStandardizedTerm: 'refund',
      sourceRows: [2, 3],
    });
    expect(refund?.normalizedSynonymTerms).toEqual([...refund!.normalizedSynonymTerms].sort());
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const logical = stableLogicalIds({
      workspaceId: 'ws_a',
      knowledgeSpaceId: 'space_a',
      mappings: result.mappings,
    });
    expect(logical[0]?.logicalMappingId).toMatch(/^[a-f0-9]{24}$/);
    expect(
      stableLogicalIds({
        workspaceId: 'ws_a',
        knowledgeSpaceId: 'space_a',
        mappings: result.mappings,
        previous: [logical[0]!],
      })[0]?.logicalMappingId,
    ).toBe(logical[0]?.logicalMappingId);
  });

  it('TEST-SEARCH-003-BLOCK rejects malformed headers and duplicate terms', () => {
    expect(
      codes(validateMappings(rows(['标准词', '标准术语', '同义词'], ['退款', '退款', '退货']))),
    ).toContain('DUPLICATE_STANDARD_HEADER');
    expect(codes(validateMappings(rows(['标准词'], ['退款'])))).toContain('SYNONYM_HEADER_MISSING');
    expect(
      codes(
        validateMappings(
          rows(
            ['标准词', '同义词', '同义词2'],
            ['Refund', '退货', 'RETURN'],
            ['refund', 'return', '返还'],
          ),
        ),
      ),
    ).toContain('DUPLICATE_TERM');
  });

  it('TEST-SEARCH-003-BLOCK classifies self, cascade, cycle and cross-standard conflicts', () => {
    expect(codes(validateMappings(rows(['标准词', '同义词'], ['Refund', 'refund'])))).toContain(
      'SELF_REFERENCE',
    );
    expect(codes(validateMappings(rows(['标准词', '同义词'], ['A', 'B'], ['B', 'C'])))).toContain(
      'CASCADE_REFERENCE',
    );
    expect(codes(validateMappings(rows(['标准词', '同义词'], ['A', 'B'], ['B', 'A'])))).toContain(
      'CYCLIC_REFERENCE',
    );
    expect(
      codes(validateMappings(rows(['标准词', '同义词'], ['A', 'shared'], ['B', 'Shared']))),
    ).toContain('CROSS_STANDARD_CONFLICT');
  });

  it('TEST-SEARCH-003-BLOCK enforces 128 code points and preserves all diagnostics', () => {
    const atLimit = 'x'.repeat(SYNONYM_LIMITS.maxTermCodePoints);
    const overLimit = `${atLimit}y`;
    expect(validateMappings(rows(['标准词', '同义词'], [atLimit, 'alias'])).ok).toBe(true);
    const result = validateMappings(
      rows(['标准词', '同义词'], [overLimit, 'alias'], ['standard-2', overLimit]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.filter((item) => item.code === 'TERM_TOO_LONG')).toHaveLength(2);
    expect(result.diagnostics.every((item) => item.rowNumber !== null)).toBe(true);
  });

  it('TEST-SEARCH-003-BLOCK enforces mapping, term and total-length limits', () => {
    const tooManyMappings = Array.from({ length: SYNONYM_LIMITS.maxMappings + 1 }, (_, index) => [
      `standard-${index}`,
      `alias-${index}`,
    ]);
    expect(
      codes(
        validateMappings([
          row(1, ['标准词', '同义词']),
          ...tooManyMappings.map((values, index) => row(index + 2, values)),
        ]),
      ),
    ).toContain('MAPPING_LIMIT_EXCEEDED');

    const manyTerms = Array.from({ length: 25_001 }, (_, index) => [
      'Bulk',
      `alias-a-${index}`,
      `alias-b-${index}`,
    ]);
    expect(
      codes(
        validateMappings([
          row(1, ['标准词', '同义词1', '同义词2']),
          ...manyTerms.map((values, index) => row(index + 2, values)),
        ]),
      ),
    ).toContain('TERM_LIMIT_EXCEEDED');

    const long = 'a'.repeat(120);
    const lengthRows = Array.from({ length: 3907 }, (_, index) => [
      `s-${index}`,
      `${long}${String(index).padStart(8, '0')}`,
    ]);
    expect(
      codes(
        validateMappings([
          row(1, ['标准词', '同义词']),
          ...lengthRows.map((values, index) => row(index + 2, values)),
        ]),
      ),
    ).toContain('TOTAL_LENGTH_EXCEEDED');
  });
});
