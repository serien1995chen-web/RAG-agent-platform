// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./vendor/safe-regex.d.ts" />

import { createHash } from 'node:crypto';
import {
  isRe2CompatibleRegexSubset,
  createKnowledgeError,
  type SearchFilterApi,
  type TagFilterCondition,
} from '@kb/contracts';
import { uniq } from 'lodash-es';
import safeRegex from 'safe-regex';

export type TagType = 'string' | 'number' | 'datetime' | 'array';

export interface FilterTagDefinition {
  tagId: string;
  knowledgeSpaceId: string;
  tagType: TagType;
  status: 'active' | 'disabled';
}

export interface FilterTagValue {
  tagId: string;
  valueKey: string;
  value: unknown;
}

export interface SourceFilterFacts {
  sourceId: string;
  knowledgeSpaceId: string;
  directoryId: string | null;
  directoryPath: string[];
  createdAt: Date;
  tagValues: FilterTagValue[];
}

export interface SearchFilterSummary {
  logic: 'AND' | 'OR';
  conditionCount: number;
  conditionHash: string;
  sourceFilterCount: number;
  directoryFilterCount: number;
  createdAtFilter: boolean;
}

export interface CompiledSearchFilter {
  allowedSourceIds: string[];
  emptyMatch: boolean;
  summary: SearchFilterSummary;
}

export interface SearchFilterErrorContext {
  requestId: string;
  traceId: string;
}

const NON_ALNUM = /[^\p{L}\p{N}]/gu;
const NEGATIVE_EMPTY_OPERATORS = new Set(['$ne', '$isNot', '$notContains', '$notIn']);

function validationError(
  context: SearchFilterErrorContext | undefined,
  details: Record<string, unknown>,
) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_VALIDATION_FAILED',
    requestId: context?.requestId ?? 'search-filter',
    traceId: context?.traceId ?? 'search-filter',
    details,
  });
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function sortedUnique(values: readonly string[]): string[] {
  return uniq(values).sort((left, right) => left.localeCompare(right));
}

function targetValues(condition: TagFilterCondition): string[] {
  if (condition.value === undefined) return [];
  if (Array.isArray(condition.value)) return sortedUnique(condition.value);
  return typeof condition.value === 'string' ? [condition.value] : [];
}

function storedArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return sortedUnique(value.filter((item): item is string => typeof item === 'string'));
}

function isAbsent(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

export function assertSafeTagRegex(pattern: string, context?: SearchFilterErrorContext): RegExp {
  if (!isRe2CompatibleRegexSubset(pattern)) {
    throw validationError(context, {
      field: 'filters.conditions.value',
      reason: 'unsafe_regex',
    });
  }
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, 'u');
  } catch {
    throw validationError(context, {
      field: 'filters.conditions.value',
      reason: 'invalid_regex',
    });
  }
  if (!safeRegex(expression, { limit: 25 })) {
    throw validationError(context, {
      field: 'filters.conditions.value',
      reason: 'unsafe_regex',
    });
  }
  return expression;
}

function evaluateString(operator: string, stored: unknown, condition: TagFilterCondition): boolean {
  const absent = isAbsent(stored);
  if (operator === '$empty') return absent;
  if (operator === '$notEmpty') return !absent;
  if (absent) return NEGATIVE_EMPTY_OPERATORS.has(operator);
  if (typeof stored !== 'string' || typeof condition.value !== 'string') return false;
  const left = asciiLower(stored);
  const right = asciiLower(condition.value);
  switch (operator) {
    case '$eq':
      return stored === condition.value;
    case '$ne':
      return stored !== condition.value;
    case '$contains':
      return left.includes(right);
    case '$notContains':
      return !left.includes(right);
    case '$startsWith':
      return left.startsWith(right);
    case '$endsWith':
      return left.endsWith(right);
    case '$regex': {
      if ([...stored].length > 256) return false;
      const startedAt = performance.now();
      const matched = assertSafeTagRegex(condition.value).test(stored);
      return matched && performance.now() - startedAt <= 50;
    }
    default:
      return false;
  }
}

function evaluateNumber(operator: string, stored: unknown, condition: TagFilterCondition): boolean {
  const absent = isAbsent(stored);
  if (operator === '$empty') return absent;
  if (operator === '$notEmpty') return !absent;
  if (absent) return operator === '$ne';
  if (typeof stored !== 'number' || typeof condition.value !== 'number') return false;
  switch (operator) {
    case '$eq':
      return stored === condition.value;
    case '$ne':
      return stored !== condition.value;
    case '$gt':
      return stored > condition.value;
    case '$lt':
      return stored < condition.value;
    case '$gte':
      return stored >= condition.value;
    case '$lte':
      return stored <= condition.value;
    default:
      return false;
  }
}

function evaluateArray(operator: string, stored: unknown, condition: TagFilterCondition): boolean {
  const absent = isAbsent(stored);
  if (operator === '$empty') return absent;
  if (operator === '$notEmpty') return !absent;
  if (absent) return NEGATIVE_EMPTY_OPERATORS.has(operator);
  const left = storedArray(stored);
  const right = targetValues(condition);
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  switch (operator) {
    case '$is':
      return left.length === right.length && left.every((item) => rightSet.has(item));
    case '$isNot':
      return !(left.length === right.length && left.every((item) => rightSet.has(item)));
    case '$contains':
      return right.every((item) => leftSet.has(item));
    case '$notContains':
      return right.every((item) => !leftSet.has(item));
    case '$in':
      return left.every((item) => rightSet.has(item));
    case '$notIn':
      return !left.every((item) => rightSet.has(item));
    default:
      return false;
  }
}

export function evaluateTagCondition(
  condition: TagFilterCondition,
  facts: SourceFilterFacts,
  definitions: ReadonlyMap<string, FilterTagDefinition>,
  context?: SearchFilterErrorContext,
): boolean {
  const definition = definitions.get(condition.tagId);
  if (!definition || definition.status !== 'active') return false;
  if (definition.knowledgeSpaceId !== facts.knowledgeSpaceId) return false;
  if (definition.tagType !== condition.tagType) {
    throw validationError(context, {
      field: 'filters.conditions.tagType',
      tagId: condition.tagId,
      expected: definition.tagType,
      actual: condition.tagType,
    });
  }
  const value = facts.tagValues.find((item) => item.tagId === condition.tagId)?.value;
  if (condition.tagType === 'string') return evaluateString(condition.operator, value, condition);
  if (condition.tagType === 'number' || condition.tagType === 'datetime') {
    return evaluateNumber(condition.operator, value, condition);
  }
  return evaluateArray(condition.operator, value, condition);
}

export function evaluateTagConditions(
  filter: SearchFilterApi | undefined,
  facts: SourceFilterFacts,
  definitions: readonly FilterTagDefinition[],
  context?: SearchFilterErrorContext,
): boolean {
  if (!filter || !filter.conditions || filter.conditions.length === 0) return true;
  const definitionMap = new Map(definitions.map((entry) => [entry.tagId, entry]));
  const matches = filter.conditions.map((condition) =>
    evaluateTagCondition(condition, facts, definitionMap, context),
  );
  return filter.logic === 'OR' ? matches.some(Boolean) : matches.every(Boolean);
}

export function compileDirectorySubtree(
  facts: SourceFilterFacts,
  targetDirectoryIds: readonly string[] | undefined,
): boolean {
  if (targetDirectoryIds === undefined) return true;
  if (targetDirectoryIds.length === 0) return false;
  const targets = new Set(targetDirectoryIds);
  if (facts.directoryId !== null && targets.has(facts.directoryId)) return true;
  return facts.directoryPath.some((directoryId) => targets.has(directoryId));
}

export function compileSearchFilter(
  filter: SearchFilterApi | undefined,
  facts: readonly SourceFilterFacts[],
  definitions: readonly FilterTagDefinition[],
  context?: SearchFilterErrorContext,
): CompiledSearchFilter {
  for (const condition of filter?.conditions ?? []) {
    if (condition.tagType === 'string' && condition.operator === '$regex') {
      assertSafeTagRegex(condition.value ?? '', context);
    }
  }
  const sourceFilter = filter?.sourceIds === undefined ? undefined : new Set(filter.sourceIds);
  const directoryFilter = filter?.directoryIds;
  const createdAt = filter?.createdAt;
  const allowedSourceIds = facts
    .filter((item) => {
      if (sourceFilter !== undefined && !sourceFilter.has(item.sourceId)) return false;
      if (!compileDirectorySubtree(item, directoryFilter)) return false;
      if (createdAt?.gte && item.createdAt.getTime() < Date.parse(createdAt.gte)) return false;
      if (createdAt?.lte && item.createdAt.getTime() > Date.parse(createdAt.lte)) return false;
      return evaluateTagConditions(filter, item, definitions, context);
    })
    .map((item) => item.sourceId);
  const conditionPayload = JSON.stringify(
    filter?.conditions?.map((condition) => ({
      tagId: condition.tagId,
      tagType: condition.tagType,
      operator: condition.operator,
      ...(condition.value !== undefined ? { value: condition.value } : {}),
    })) ?? [],
  );
  return {
    allowedSourceIds,
    emptyMatch: allowedSourceIds.length === 0,
    summary: {
      logic: filter?.logic ?? 'AND',
      conditionCount: filter?.conditions?.length ?? 0,
      conditionHash: createHash('sha256').update(conditionPayload).digest('hex'),
      sourceFilterCount: filter?.sourceIds?.length ?? 0,
      directoryFilterCount: filter?.directoryIds?.length ?? 0,
      createdAtFilter: Boolean(filter?.createdAt),
    },
  };
}

export function normalizedDedupeText(text: string): string {
  return text.normalize('NFKC').replace(NON_ALNUM, '');
}
