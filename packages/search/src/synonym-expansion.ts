export const SYNONYM_QUERY_MAX_CODE_POINTS = 4096;

export interface SynonymExpansionMapping {
  logicalMappingId: string;
  standardizedTerm: string;
  normalizedStandardizedTerm: string;
  synonymTerms: readonly string[];
  normalizedSynonymTerms: readonly string[];
}

export interface SynonymExpansionContext {
  knowledgeSpaceId: string;
  fileVersion: number;
  mappings: readonly SynonymExpansionMapping[];
}

export interface SynonymExpansionHit {
  knowledgeSpaceId: string;
  fileVersion: number;
  logicalMappingId: string;
  standardizedTerm: string;
  normalizedStandardizedTerm: string;
  matchedTerm: string;
  start: number;
  end: number;
}

export interface SynonymExpansionResult {
  originalQuery: string;
  expandedQuery: string;
  hits: SynonymExpansionHit[];
  normalizedStandardTerms: string[];
  appliedMappingIds: string[];
  fallbackReason:
    | 'disabled'
    | 'version_changed'
    | 'cache_mismatch'
    | 'safety'
    | 'code_point_limit'
    | null;
}

interface ProtectedSpan {
  start: number;
  end: number;
}

interface SynonymRule {
  mapping: SynonymExpansionMapping;
  normalizedTerm: string;
  displayTerm: string;
}

function asciiLower(value: string): string {
  let output = '';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    output += code >= 65 && code <= 90 ? String.fromCodePoint(code + 32) : character;
  }
  return output;
}

export function normalizeSynonymTerm(value: string): string {
  return asciiLower(value.trim());
}

export function synonymCodePointLength(value: string): number {
  return [...value].length;
}

function isAsciiWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z0-9_]$/.test(value);
}

function boundaryMatches(text: string, start: number, end: number, term: string): boolean {
  const first = [...term][0];
  const last = [...term].at(-1);
  const previous = start > 0 ? [...text.slice(0, start)].at(-1) : undefined;
  const next = end < text.length ? [...text.slice(end)][0] : undefined;
  if (isAsciiWordCharacter(first) && isAsciiWordCharacter(previous)) return false;
  if (isAsciiWordCharacter(last) && isAsciiWordCharacter(next)) return false;
  return true;
}

function mergeSpans(spans: readonly ProtectedSpan[]): ProtectedSpan[] {
  const sorted = [...spans].sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: ProtectedSpan[] = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (!previous || span.start > previous.end) {
      merged.push({ ...span });
    } else {
      previous.end = Math.max(previous.end, span.end);
    }
  }
  return merged;
}

export function protectStandardTerms(
  query: string,
  mappings: readonly SynonymExpansionMapping[],
): ProtectedSpan[] {
  const lowerQuery = asciiLower(query);
  const standards = [
    ...new Map(
      mappings.map((mapping) => [
        mapping.normalizedStandardizedTerm,
        mapping.normalizedStandardizedTerm,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      synonymCodePointLength(right) - synonymCodePointLength(left) || left.localeCompare(right),
  );
  const spans: ProtectedSpan[] = [];
  for (let index = 0; index < lowerQuery.length; ) {
    const standard = standards.find(
      (term) =>
        term.length > 0 &&
        lowerQuery.startsWith(term, index) &&
        boundaryMatches(lowerQuery, index, index + term.length, term),
    );
    if (standard) {
      spans.push({ start: index, end: index + standard.length });
      index += standard.length;
    } else {
      index += 1;
    }
  }
  return mergeSpans(spans);
}

function inProtectedSpan(
  index: number,
  spans: readonly ProtectedSpan[],
): ProtectedSpan | undefined {
  return spans.find((span) => index >= span.start && index < span.end);
}

function compareMappings(left: SynonymExpansionMapping, right: SynonymExpansionMapping): number {
  return (
    left.normalizedStandardizedTerm.localeCompare(right.normalizedStandardizedTerm) ||
    left.logicalMappingId.localeCompare(right.logicalMappingId)
  );
}

export function expandQuery(
  query: string,
  mappings: readonly SynonymExpansionMapping[],
): SynonymExpansionResult {
  const lowerQuery = asciiLower(query);
  const protectedSpans = protectStandardTerms(query, mappings);
  const rules = mappings
    .flatMap((mapping): SynonymRule[] =>
      mapping.normalizedSynonymTerms.map((normalizedTerm, index) => ({
        mapping,
        normalizedTerm,
        displayTerm: mapping.synonymTerms[index] ?? normalizedTerm,
      })),
    )
    .filter((rule) => rule.normalizedTerm.length > 0)
    .sort(
      (left, right) =>
        synonymCodePointLength(right.normalizedTerm) -
          synonymCodePointLength(left.normalizedTerm) ||
        compareMappings(left.mapping, right.mapping) ||
        left.normalizedTerm.localeCompare(right.normalizedTerm),
    );
  const hits: SynonymExpansionHit[] = [];
  for (let index = 0; index < lowerQuery.length; ) {
    const protectedSpan = inProtectedSpan(index, protectedSpans);
    if (protectedSpan) {
      index = protectedSpan.end;
      continue;
    }
    const rule = rules.find(
      (candidate) =>
        lowerQuery.startsWith(candidate.normalizedTerm, index) &&
        boundaryMatches(
          lowerQuery,
          index,
          index + candidate.normalizedTerm.length,
          candidate.normalizedTerm,
        ),
    );
    if (!rule) {
      index += 1;
      continue;
    }
    hits.push({
      knowledgeSpaceId: '',
      fileVersion: 0,
      logicalMappingId: rule.mapping.logicalMappingId,
      standardizedTerm: rule.mapping.standardizedTerm,
      normalizedStandardizedTerm: rule.mapping.normalizedStandardizedTerm,
      matchedTerm: query.slice(index, index + rule.normalizedTerm.length),
      start: index,
      end: index + rule.normalizedTerm.length,
    });
    index += rule.normalizedTerm.length;
  }
  const orderedMappings = [...mappings].sort(compareMappings);
  const hitIds = new Set(hits.map((hit) => hit.logicalMappingId));
  const additions = orderedMappings.filter((mapping) => hitIds.has(mapping.logicalMappingId));
  return synonymResult(query, additions, hits, null);
}

function synonymResult(
  query: string,
  mappings: readonly SynonymExpansionMapping[],
  hits: readonly SynonymExpansionHit[],
  fallbackReason: SynonymExpansionResult['fallbackReason'],
): SynonymExpansionResult {
  const additions: string[] = [];
  const seen = new Set<string>();
  for (const mapping of mappings) {
    if (seen.has(mapping.normalizedStandardizedTerm)) continue;
    seen.add(mapping.normalizedStandardizedTerm);
    additions.push(mapping.standardizedTerm);
  }
  const candidate =
    additions.length > 0 ? `${query}${/\s$/.test(query) ? '' : ' '}${additions.join(' ')}` : query;
  if (synonymCodePointLength(candidate) > SYNONYM_QUERY_MAX_CODE_POINTS && !fallbackReason) {
    return {
      originalQuery: query,
      expandedQuery: query,
      hits: [...hits],
      normalizedStandardTerms: [],
      appliedMappingIds: [],
      fallbackReason: 'code_point_limit',
    };
  }
  return {
    originalQuery: query,
    expandedQuery: fallbackReason === 'code_point_limit' ? query : candidate,
    hits: [...hits],
    normalizedStandardTerms: fallbackReason
      ? []
      : mappings.map((mapping) => mapping.normalizedStandardizedTerm),
    appliedMappingIds: fallbackReason ? [] : mappings.map((mapping) => mapping.logicalMappingId),
    fallbackReason,
  };
}

export function fallbackSynonymExpansion(
  query: string,
  fallbackReason: Exclude<SynonymExpansionResult['fallbackReason'], null> = 'safety',
): SynonymExpansionResult {
  return synonymResult(query, [], [], fallbackReason);
}

export function mergeExpansions(input: {
  queries: readonly string[];
  contexts: readonly SynonymExpansionContext[];
}): SynonymExpansionResult[] {
  return input.queries.map((query) => {
    const orderedHits: SynonymExpansionHit[] = [];
    const orderedMappings: Array<{
      mapping: SynonymExpansionMapping;
      context: SynonymExpansionContext;
    }> = [];
    for (const context of input.contexts) {
      const local = expandQuery(query, context.mappings);
      for (const hit of local.hits) {
        orderedHits.push({
          ...hit,
          knowledgeSpaceId: context.knowledgeSpaceId,
          fileVersion: context.fileVersion,
        });
      }
      const hitIds = new Set(local.hits.map((hit) => hit.logicalMappingId));
      for (const mapping of [...context.mappings].sort(compareMappings)) {
        if (hitIds.has(mapping.logicalMappingId)) {
          orderedMappings.push({ mapping, context });
        }
      }
    }
    const uniqueByStandard = new Map<string, SynonymExpansionMapping>();
    for (const entry of orderedMappings) {
      if (!uniqueByStandard.has(entry.mapping.normalizedStandardizedTerm)) {
        uniqueByStandard.set(entry.mapping.normalizedStandardizedTerm, entry.mapping);
      }
    }
    return synonymResult(query, [...uniqueByStandard.values()], orderedHits, null);
  });
}
