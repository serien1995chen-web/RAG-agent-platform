import { createHash } from 'node:crypto';

export const SYNONYM_LIMITS = Object.freeze({
  maxMappings: 10_000,
  maxTerms: 50_000,
  maxTermCodePoints: 128,
  maxTotalCodePoints: 500_000,
  maxDiagnostics: 100,
});

export interface SynonymDiagnostic {
  rowNumber: number | null;
  columnNumber: number | null;
  code: string;
  messageKey: string;
  params: Record<string, string | number | boolean>;
}

export interface SynonymInputCell {
  columnNumber: number;
  value: string;
}

export interface SynonymInputRow {
  rowNumber: number;
  cells: SynonymInputCell[];
}

export interface SynonymMappingCandidate {
  standardizedTerm: string;
  normalizedStandardizedTerm: string;
  synonymTerms: string[];
  normalizedSynonymTerms: string[];
  allTerms: string;
  fingerprint: string;
  sourceRows: number[];
}

export interface SynonymMapping extends SynonymMappingCandidate {
  logicalMappingId: string;
}

export interface SynonymPreviousMapping {
  logicalMappingId: string;
  normalizedStandardizedTerm: string;
}

export type SynonymValidationResult =
  | {
      ok: true;
      mappings: SynonymMappingCandidate[];
      fingerprint: string;
      mappingCount: number;
      termCount: number;
      totalCodePoints: number;
    }
  | {
      ok: false;
      diagnostics: SynonymDiagnostic[];
      totalDiagnostics: number;
      truncated: boolean;
    };

interface HeaderColumns {
  standard: number;
  synonyms: number[];
}

interface SynonymOccurrence {
  standardizedTerm: string;
  normalizedStandardizedTerm: string;
  rowNumber: number;
  columnNumber: number;
  value: string;
  normalizedValue: string;
}

interface MappingGroup {
  standardizedTerm: string;
  normalizedStandardizedTerm: string;
  synonyms: Map<
    string,
    {
      value: string;
      rowNumber: number;
      columnNumber: number;
    }
  >;
  sourceRows: Set<number>;
}

function asciiLower(value: string): string {
  let output = '';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    output += code >= 65 && code <= 90 ? String.fromCodePoint(code + 32) : character;
  }
  return output;
}

export function normalizeTerm(value: string): string {
  return asciiLower(value.trim());
}

export function codePointLength(value: string): number {
  return [...value].length;
}

export function isAsciiWordCharacter(value: string | undefined): boolean {
  if (!value) return false;
  return /^[A-Za-z0-9_]$/.test(value);
}

export function hasLatinBoundary(text: string, start: number, end: number, term: string): boolean {
  const first = [...term][0];
  const last = [...term].at(-1);
  const previous = start > 0 ? [...text.slice(0, start)].at(-1) : undefined;
  const next = end < text.length ? [...text.slice(end)][0] : undefined;
  if (isAsciiWordCharacter(first) && isAsciiWordCharacter(previous)) return false;
  if (isAsciiWordCharacter(last) && isAsciiWordCharacter(next)) return false;
  return true;
}

function diagnostic(input: {
  rowNumber?: number | null;
  columnNumber?: number | null;
  code: string;
  params?: Record<string, string | number | boolean>;
}): SynonymDiagnostic {
  return {
    rowNumber: input.rowNumber ?? null,
    columnNumber: input.columnNumber ?? null,
    code: input.code,
    messageKey: `knowledge.synonym.invalid.${input.code.toLowerCase()}`,
    params: input.params ?? {},
  };
}

class Diagnostics {
  private readonly values: SynonymDiagnostic[] = [];
  total = 0;

  push(value: SynonymDiagnostic): void {
    this.total += 1;
    if (this.values.length < SYNONYM_LIMITS.maxDiagnostics) this.values.push(value);
  }

  get truncated(): boolean {
    return this.total > this.values.length;
  }

  get items(): SynonymDiagnostic[] {
    return [...this.values];
  }
}

function isBlankRow(row: SynonymInputRow): boolean {
  return row.cells.every((cell) => cell.value.trim().length === 0);
}

function isStandardHeader(value: string): boolean {
  return ['标准词', '标准术语', 'standardizedterm', 'standardterm'].includes(value);
}

function isSynonymHeader(value: string): boolean {
  return (
    /^同义词(?:\d+)?$/.test(value) ||
    /^(?:synonym|synonyms|synonymterm|synonymterms)(?:\d+)?$/.test(value)
  );
}

function headerColumns(
  rows: readonly SynonymInputRow[],
  diagnostics: Diagnostics,
): HeaderColumns | null {
  const header = rows[0];
  if (!header) {
    diagnostics.push(diagnostic({ rowNumber: 1, code: 'HEADER_REQUIRED' }));
    return null;
  }
  const standards: Array<{ columnNumber: number; value: string }> = [];
  const synonyms: number[] = [];
  const seen = new Set<string>();
  for (const cell of header.cells) {
    const value = normalizeTerm(cell.value);
    if (!value) continue;
    if (seen.has(value)) {
      diagnostics.push(
        diagnostic({
          rowNumber: header.rowNumber,
          columnNumber: cell.columnNumber,
          code: 'DUPLICATE_HEADER',
        }),
      );
      continue;
    }
    seen.add(value);
    if (isStandardHeader(value)) {
      standards.push({ columnNumber: cell.columnNumber, value });
    } else if (isSynonymHeader(value)) {
      synonyms.push(cell.columnNumber);
    } else {
      diagnostics.push(
        diagnostic({
          rowNumber: header.rowNumber,
          columnNumber: cell.columnNumber,
          code: 'UNSUPPORTED_HEADER',
        }),
      );
    }
  }
  if (standards.length === 0) {
    diagnostics.push(diagnostic({ rowNumber: header.rowNumber, code: 'STANDARD_HEADER_MISSING' }));
  } else if (standards.length > 1) {
    diagnostics.push(
      diagnostic({
        rowNumber: header.rowNumber,
        columnNumber: standards[1]!.columnNumber,
        code: 'DUPLICATE_STANDARD_HEADER',
      }),
    );
  }
  if (synonyms.length === 0) {
    diagnostics.push(diagnostic({ rowNumber: header.rowNumber, code: 'SYNONYM_HEADER_MISSING' }));
  }
  return standards.length === 1 && synonyms.length > 0
    ? { standard: standards[0]!.columnNumber, synonyms }
    : null;
}

function cellAt(row: SynonymInputRow, columnNumber: number): SynonymInputCell {
  return (
    row.cells.find((cell) => cell.columnNumber === columnNumber) ?? {
      columnNumber,
      value: '',
    }
  );
}

function findCyclicStandards(groups: readonly MappingGroup[]): Set<string> {
  const standards = new Set(groups.map((group) => group.normalizedStandardizedTerm));
  const graph = new Map<string, string[]>();
  for (const group of groups) {
    graph.set(
      group.normalizedStandardizedTerm,
      [...group.synonyms.keys()].filter((term) => standards.has(term)),
    );
  }
  let index = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cyclic = new Set<string>();

  const visit = (node: string) => {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(next)!));
      } else if (onStack.has(next)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(next)!));
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let current: string | undefined;
    do {
      current = stack.pop();
      if (!current) break;
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    if (component.length > 1) {
      for (const value of component) cyclic.add(value);
    }
  };

  for (const node of graph.keys()) {
    if (!indices.has(node)) visit(node);
  }
  return cyclic;
}

function validateReferences(groups: readonly MappingGroup[], diagnostics: Diagnostics): void {
  const standards = new Set(groups.map((group) => group.normalizedStandardizedTerm));
  const cyclic = findCyclicStandards(groups);
  const nonStandardOwners = new Map<string, SynonymOccurrence[]>();
  for (const group of groups) {
    for (const [normalizedValue, synonym] of group.synonyms) {
      if (normalizedValue === group.normalizedStandardizedTerm) {
        diagnostics.push(
          diagnostic({
            rowNumber: synonym.rowNumber,
            columnNumber: synonym.columnNumber,
            code: 'SELF_REFERENCE',
          }),
        );
        continue;
      }
      if (standards.has(normalizedValue)) {
        diagnostics.push(
          diagnostic({
            rowNumber: synonym.rowNumber,
            columnNumber: synonym.columnNumber,
            code: cyclic.has(normalizedValue) ? 'CYCLIC_REFERENCE' : 'CASCADE_REFERENCE',
          }),
        );
        continue;
      }
      const owners = nonStandardOwners.get(normalizedValue) ?? [];
      owners.push({
        standardizedTerm: group.standardizedTerm,
        normalizedStandardizedTerm: group.normalizedStandardizedTerm,
        rowNumber: synonym.rowNumber,
        columnNumber: synonym.columnNumber,
        value: synonym.value,
        normalizedValue,
      });
      nonStandardOwners.set(normalizedValue, owners);
    }
  }
  for (const owners of nonStandardOwners.values()) {
    if (new Set(owners.map((owner) => owner.normalizedStandardizedTerm)).size < 2) continue;
    for (const owner of owners) {
      diagnostics.push(
        diagnostic({
          rowNumber: owner.rowNumber,
          columnNumber: owner.columnNumber,
          code: 'CROSS_STANDARD_CONFLICT',
        }),
      );
    }
  }
}

export function fingerprintMapping(input: {
  normalizedStandardizedTerm: string;
  normalizedSynonymTerms: readonly string[];
}): string {
  return createHash('sha256')
    .update(input.normalizedStandardizedTerm, 'utf8')
    .update('\0')
    .update([...input.normalizedSynonymTerms].sort().join('\x1f'), 'utf8')
    .digest('hex');
}

export function validateMappings(rows: readonly SynonymInputRow[]): SynonymValidationResult {
  const diagnostics = new Diagnostics();
  const columns = headerColumns(rows, diagnostics);
  if (!columns) {
    return {
      ok: false,
      diagnostics: diagnostics.items,
      totalDiagnostics: diagnostics.total,
      truncated: diagnostics.truncated,
    };
  }

  const groups = new Map<string, MappingGroup>();
  let termCount = 0;
  let totalCodePoints = 0;
  for (const row of rows.slice(1)) {
    if (isBlankRow(row)) continue;
    const standardCell = cellAt(row, columns.standard);
    const standard = standardCell.value.trim();
    const synonymCells = columns.synonyms.map((columnNumber) => cellAt(row, columnNumber));
    const nonEmptySynonyms = synonymCells.filter((cell) => cell.value.trim().length > 0);
    if (!standard && nonEmptySynonyms.length > 0) {
      diagnostics.push(
        diagnostic({
          rowNumber: row.rowNumber,
          columnNumber: standardCell.columnNumber,
          code: 'EMPTY_STANDARD',
        }),
      );
      continue;
    }
    if (!standard) continue;
    if (nonEmptySynonyms.length === 0) {
      diagnostics.push(
        diagnostic({
          rowNumber: row.rowNumber,
          columnNumber: standardCell.columnNumber,
          code: 'EMPTY_SYNONYM',
        }),
      );
      continue;
    }
    const normalizedStandard = normalizeTerm(standard);
    termCount += 1;
    totalCodePoints += codePointLength(standard);
    if (codePointLength(standard) > SYNONYM_LIMITS.maxTermCodePoints) {
      diagnostics.push(
        diagnostic({
          rowNumber: row.rowNumber,
          columnNumber: standardCell.columnNumber,
          code: 'TERM_TOO_LONG',
          params: { maxCodePoints: SYNONYM_LIMITS.maxTermCodePoints },
        }),
      );
    }
    const group = groups.get(normalizedStandard) ?? {
      standardizedTerm: standard,
      normalizedStandardizedTerm: normalizedStandard,
      synonyms: new Map(),
      sourceRows: new Set<number>(),
    };
    group.sourceRows.add(row.rowNumber);
    groups.set(normalizedStandard, group);
    for (const synonymCell of nonEmptySynonyms) {
      const synonym = synonymCell.value.trim();
      const normalizedSynonym = normalizeTerm(synonym);
      termCount += 1;
      totalCodePoints += codePointLength(synonym);
      if (codePointLength(synonym) > SYNONYM_LIMITS.maxTermCodePoints) {
        diagnostics.push(
          diagnostic({
            rowNumber: row.rowNumber,
            columnNumber: synonymCell.columnNumber,
            code: 'TERM_TOO_LONG',
            params: { maxCodePoints: SYNONYM_LIMITS.maxTermCodePoints },
          }),
        );
      }
      if (group.synonyms.has(normalizedSynonym)) {
        diagnostics.push(
          diagnostic({
            rowNumber: row.rowNumber,
            columnNumber: synonymCell.columnNumber,
            code: 'DUPLICATE_TERM',
          }),
        );
        continue;
      }
      group.synonyms.set(normalizedSynonym, {
        value: synonym,
        rowNumber: row.rowNumber,
        columnNumber: synonymCell.columnNumber,
      });
    }
  }

  if (groups.size > SYNONYM_LIMITS.maxMappings) {
    diagnostics.push(
      diagnostic({
        code: 'MAPPING_LIMIT_EXCEEDED',
        params: { max: SYNONYM_LIMITS.maxMappings },
      }),
    );
  }
  if (termCount > SYNONYM_LIMITS.maxTerms) {
    diagnostics.push(
      diagnostic({
        code: 'TERM_LIMIT_EXCEEDED',
        params: { max: SYNONYM_LIMITS.maxTerms },
      }),
    );
  }
  if (totalCodePoints > SYNONYM_LIMITS.maxTotalCodePoints) {
    diagnostics.push(
      diagnostic({
        code: 'TOTAL_LENGTH_EXCEEDED',
        params: { max: SYNONYM_LIMITS.maxTotalCodePoints },
      }),
    );
  }
  validateReferences([...groups.values()], diagnostics);
  if (diagnostics.total > 0) {
    return {
      ok: false,
      diagnostics: diagnostics.items,
      totalDiagnostics: diagnostics.total,
      truncated: diagnostics.truncated,
    };
  }

  const mappings = [...groups.values()]
    .sort(
      (left, right) =>
        left.normalizedStandardizedTerm.localeCompare(right.normalizedStandardizedTerm) ||
        left.standardizedTerm.localeCompare(right.standardizedTerm),
    )
    .map((group): SynonymMappingCandidate => {
      const orderedSynonyms = [...group.synonyms.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      );
      const normalizedSynonymTerms = orderedSynonyms.map(([normalized]) => normalized);
      return {
        standardizedTerm: group.standardizedTerm,
        normalizedStandardizedTerm: group.normalizedStandardizedTerm,
        synonymTerms: orderedSynonyms.map(([, synonym]) => synonym.value),
        normalizedSynonymTerms,
        allTerms: [
          group.standardizedTerm,
          ...orderedSynonyms.map(([, synonym]) => synonym.value),
        ].join(' '),
        fingerprint: fingerprintMapping({
          normalizedStandardizedTerm: group.normalizedStandardizedTerm,
          normalizedSynonymTerms,
        }),
        sourceRows: [...group.sourceRows].sort((left, right) => left - right),
      };
    });
  const fingerprint = createHash('sha256')
    .update(
      mappings
        .map((mapping) => `${mapping.normalizedStandardizedTerm}\0${mapping.fingerprint}`)
        .join('\n'),
      'utf8',
    )
    .digest('hex');
  return {
    ok: true,
    mappings,
    fingerprint,
    mappingCount: mappings.length,
    termCount,
    totalCodePoints,
  };
}

export function stableLogicalIds(input: {
  workspaceId: string;
  knowledgeSpaceId: string;
  mappings: readonly SynonymMappingCandidate[];
  previous?: readonly SynonymPreviousMapping[];
}): SynonymMapping[] {
  const previous = new Map(
    (input.previous ?? []).map((mapping) => [
      mapping.normalizedStandardizedTerm,
      mapping.logicalMappingId,
    ]),
  );
  const namespace = `${input.workspaceId}\0${input.knowledgeSpaceId}\0`;
  return input.mappings.map((mapping) => ({
    ...mapping,
    logicalMappingId:
      previous.get(mapping.normalizedStandardizedTerm) ??
      createHash('sha256')
        .update(namespace, 'utf8')
        .update(mapping.normalizedStandardizedTerm, 'utf8')
        .digest('hex')
        .slice(0, 24),
  }));
}

export function synonymFingerprint(mappings: readonly SynonymMapping[]): string {
  return createHash('sha256')
    .update(
      [...mappings]
        .sort((left, right) =>
          left.normalizedStandardizedTerm.localeCompare(right.normalizedStandardizedTerm),
        )
        .map((mapping) => `${mapping.normalizedStandardizedTerm}\0${mapping.fingerprint}`)
        .join('\n'),
      'utf8',
    )
    .digest('hex');
}

export function mappingMetrics(mappings: readonly SynonymMapping[]): {
  mappingCount: number;
  termCount: number;
} {
  return {
    mappingCount: mappings.length,
    termCount: mappings.reduce(
      (total, mapping) => total + 1 + mapping.normalizedSynonymTerms.length,
      0,
    ),
  };
}
