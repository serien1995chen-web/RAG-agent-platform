import { createKnowledgeError } from '@kb/contracts';
import { DEFAULT_CHUNK_POLICY, type ChunkPolicy } from './token-count';

export interface ChunkingSettings {
  trainingType: 'chunk' | 'qa' | 'imageParse' | 'backup' | 'template';
  chunkSettingMode: 'auto' | 'custom' | 'intelligent';
  chunkTriggerType?: 'minSize' | 'forceChunk' | 'maxSize';
  chunkTriggerMinSize?: number;
  chunkSplitMode?: 'paragraph' | 'size' | 'char';
  paragraphChunkAIMode?: 'auto' | 'force' | 'forbid';
  paragraphChunkDeep?: number;
  paragraphChunkMinSize?: number;
  chunkSize?: number;
  chunkSplitter?: string;
  indexSize?: number;
  dataEnhanceCollectionName?: boolean;
  imageIndex?: boolean;
  autoIndexes?: boolean;
  indexPrefixTitle?: boolean;
  qaPrompt?: string;
}

interface SettingsIssue {
  path: string;
  message: string;
}

const ALLOWED_KEYS = new Set<keyof ChunkingSettings>([
  'trainingType',
  'chunkSettingMode',
  'chunkTriggerType',
  'chunkTriggerMinSize',
  'chunkSplitMode',
  'paragraphChunkAIMode',
  'paragraphChunkDeep',
  'paragraphChunkMinSize',
  'chunkSize',
  'chunkSplitter',
  'indexSize',
  'dataEnhanceCollectionName',
  'imageIndex',
  'autoIndexes',
  'indexPrefixTitle',
  'qaPrompt',
]);

function integerInRange(
  value: unknown,
  path: string,
  min: number,
  max: number,
  issues: SettingsIssue[],
): value is number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    issues.push({ path, message: `must be an integer from ${min} to ${max}` });
    return false;
  }
  return true;
}

export function validateChunkingSettings(
  value: unknown,
): { success: true; data: ChunkingSettings } | { success: false; issues: SettingsIssue[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { success: false, issues: [{ path: 'settings', message: 'object required' }] };
  }
  const input = value as Record<string, unknown>;
  const issues: SettingsIssue[] = [];
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key as keyof ChunkingSettings)) {
      issues.push({ path: key, message: 'unknown field' });
    }
  }
  if (!['chunk', 'qa', 'imageParse', 'backup', 'template'].includes(String(input.trainingType))) {
    issues.push({ path: 'trainingType', message: 'unsupported value' });
  }
  if (!['auto', 'custom', 'intelligent'].includes(String(input.chunkSettingMode))) {
    issues.push({ path: 'chunkSettingMode', message: 'unsupported value' });
  }
  if (
    input.chunkTriggerType !== undefined &&
    !['minSize', 'forceChunk', 'maxSize'].includes(String(input.chunkTriggerType))
  ) {
    issues.push({ path: 'chunkTriggerType', message: 'unsupported value' });
  }
  if (
    input.chunkSplitMode !== undefined &&
    !['paragraph', 'size', 'char'].includes(String(input.chunkSplitMode))
  ) {
    issues.push({ path: 'chunkSplitMode', message: 'unsupported value' });
  }
  if (
    input.paragraphChunkAIMode !== undefined &&
    !['auto', 'force', 'forbid'].includes(String(input.paragraphChunkAIMode))
  ) {
    issues.push({ path: 'paragraphChunkAIMode', message: 'unsupported value' });
  }
  if (input.chunkTriggerMinSize !== undefined) {
    integerInRange(input.chunkTriggerMinSize, 'chunkTriggerMinSize', 1, 8_000, issues);
  }
  if (input.paragraphChunkDeep !== undefined) {
    integerInRange(input.paragraphChunkDeep, 'paragraphChunkDeep', 0, 5, issues);
  }
  if (input.paragraphChunkMinSize !== undefined) {
    integerInRange(input.paragraphChunkMinSize, 'paragraphChunkMinSize', 1, 8_000, issues);
  }
  if (input.chunkSize !== undefined) {
    integerInRange(input.chunkSize, 'chunkSize', 64, 8_000, issues);
  }
  if (input.indexSize !== undefined) {
    integerInRange(input.indexSize, 'indexSize', 1, 8_000, issues);
  }
  if (input.chunkSettingMode === 'custom' && input.chunkSize === undefined) {
    issues.push({ path: 'chunkSize', message: 'required in custom mode' });
  }
  if (
    typeof input.chunkSize === 'number' &&
    ((typeof input.chunkTriggerMinSize === 'number' &&
      input.chunkTriggerMinSize > input.chunkSize) ||
      (typeof input.paragraphChunkMinSize === 'number' &&
        input.paragraphChunkMinSize > input.chunkSize))
  ) {
    issues.push({ path: 'chunkSize', message: 'must be greater than or equal to min size' });
  }
  if (input.chunkSplitter !== undefined) {
    if (typeof input.chunkSplitter !== 'string' || input.chunkSplitter.length > 1_000) {
      issues.push({
        path: 'chunkSplitter',
        message: 'must be a string of at most 1000 characters',
      });
    } else {
      const rules = input.chunkSplitter.split(/\r?\n/).filter((entry) => entry.trim().length > 0);
      if (rules.length > 5 || rules.some((entry) => entry.length > 200)) {
        issues.push({ path: 'chunkSplitter', message: 'max 5 rules of 200 characters each' });
      }
    }
  }
  if (input.qaPrompt !== undefined) {
    if (typeof input.qaPrompt !== 'string' || [...input.qaPrompt].length > 20_000) {
      issues.push({ path: 'qaPrompt', message: 'must be at most 20000 characters' });
    }
  }
  for (const key of [
    'dataEnhanceCollectionName',
    'imageIndex',
    'autoIndexes',
    'indexPrefixTitle',
  ] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') {
      issues.push({ path: key, message: 'must be boolean' });
    }
  }
  return issues.length > 0
    ? { success: false, issues }
    : { success: true, data: input as unknown as ChunkingSettings };
}

export const S5ChunkingSettingsSchema = {
  safeParse: validateChunkingSettings,
};

export function toChunkPolicy(settings: ChunkingSettings): ChunkPolicy {
  const parsed = validateChunkingSettings(settings);
  if (!parsed.success) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: 'chunk-settings',
      traceId: 'chunk-settings',
      details: {
        issues: parsed.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
    });
  }
  const value = parsed.data;
  const customRegs =
    value.chunkSplitter
      ?.split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];
  const lengthUnit = value.chunkSplitMode === 'char' ? 'char' : 'token';
  const mode =
    value.chunkSettingMode !== 'custom'
      ? 'auto'
      : value.chunkSplitMode === 'paragraph'
        ? 'paragraph'
        : 'custom';
  const chunkSize = value.chunkSize ?? DEFAULT_CHUNK_POLICY.chunkSize;
  const explicitMin = value.chunkTriggerMinSize ?? value.paragraphChunkMinSize;
  return {
    mode,
    chunkSize,
    minSize: explicitMin ?? Math.min(DEFAULT_CHUNK_POLICY.minSize, chunkSize),
    maxSize: Math.max(chunkSize, value.indexSize ?? DEFAULT_CHUNK_POLICY.maxSize),
    overlapRatio: 0.15,
    paragraphDeep: Math.max(1, value.paragraphChunkDeep ?? DEFAULT_CHUNK_POLICY.paragraphDeep),
    customRegs,
    lengthUnit,
    forceSplit: true,
    maxChunks: 50_000,
  };
}
