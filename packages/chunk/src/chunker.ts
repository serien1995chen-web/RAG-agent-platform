/**
 * @kb/chunk 确定性切分算法（设计文档 9.8.1 第 3–8 步）。
 * 相同输入与策略必须产生完全相同的 chunk 序列；空输入返回空数组。
 * overlap 仅在相邻文本块之间生效，表格/自定义分隔边界不重叠。
 */
import { createKnowledgeError, type KnowledgeApiError } from '@kb/contracts';
import { contentHashOfChunk, type ChunkOutput, type ChunkPolicy } from './token-count';
import type { Segment } from './paragraph';
import { buildSegments, normalizeChunkText } from './paragraph';
import type { Counter } from './token-count';
import { createCounter } from './token-count';

export const CHUNK_LIMIT_ERROR_CODE = 'KNOWLEDGE_VALIDATION_FAILED' as const;

export function chunkLimitError(
  params: Record<string, unknown>,
  requestId = 'chunk',
): KnowledgeApiError {
  return createKnowledgeError({
    code: CHUNK_LIMIT_ERROR_CODE,
    requestId,
    traceId: requestId,
    details: params,
  });
}

function validatePolicy(policy: ChunkPolicy): void {
  const fail = (actual: number): never => {
    throw chunkLimitError({ maxChunks: policy.maxChunks, actual, chunkSize: policy.chunkSize });
  };
  if (policy.chunkSize < 64 || policy.chunkSize > 100_000) fail(policy.chunkSize);
  if (policy.minSize < 1 || policy.minSize > 100_000) fail(policy.minSize);
  if (policy.maxSize < 500 || policy.maxSize > 100_000) fail(policy.maxSize);
  if (!(policy.minSize <= policy.chunkSize && policy.chunkSize <= policy.maxSize))
    fail(policy.chunkSize);
  if (policy.overlapRatio < 0 || policy.overlapRatio > 0.9) fail(policy.overlapRatio);
  if (
    policy.overlapSize !== undefined &&
    (!Number.isInteger(policy.overlapSize) ||
      policy.overlapSize < 0 ||
      policy.overlapSize >= policy.chunkSize)
  ) {
    fail(policy.overlapSize);
  }
  if (policy.paragraphDeep < 1 || policy.paragraphDeep > 8) fail(policy.paragraphDeep);
  if (policy.customRegs.length > 5 || policy.customRegs.some((reg) => reg.length > 200)) {
    fail(policy.customRegs.length);
  }
  if (policy.maxChunks < 1 || policy.maxChunks > 50000) fail(policy.maxChunks);
}

function isAtomic(segment: Segment): boolean {
  return segment.kind === 'table' || segment.kind === 'custom';
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?.])\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 超长片段：按句子边界，再按 code point 硬切；forceSplit=false 时稳定拒绝。 */
function expandOversized(segments: Segment[], policy: ChunkPolicy, counter: Counter): Segment[] {
  const expanded: Segment[] = [];
  for (const segment of segments) {
    if (isAtomic(segment) || counter.length(segment.text) <= policy.chunkSize) {
      expanded.push(segment);
      continue;
    }
    for (const sentence of splitSentences(segment.text)) {
      if (counter.length(sentence) <= policy.chunkSize) {
        expanded.push({ text: sentence, kind: 'text' });
        continue;
      }
      if (!policy.forceSplit) {
        throw chunkLimitError({
          maxChunks: policy.maxChunks,
          actual: counter.length(sentence),
          chunkSize: policy.chunkSize,
        });
      }
      for (const piece of counter.split(sentence, policy.chunkSize)) {
        expanded.push({ text: piece, kind: 'text' });
      }
    }
  }
  return expanded;
}

interface MergeState {
  policy: ChunkPolicy;
  counter: Counter;
  chunks: Array<{ text: string; group: number }>;
  current: Segment[];
  currentLength: number;
  lastKind: Segment['kind'] | null;
  group: number;
}

function flush(state: MergeState): void {
  if (state.current.length === 0) return;
  const text = state.current
    .map((segment) => segment.text)
    .join('\n')
    .trim();
  state.lastKind = state.current[state.current.length - 1]?.kind ?? null;
  state.current = [];
  state.currentLength = 0;
  if (text.length > 0) state.chunks.push({ text, group: state.group });
}

function buildSingleSegment(segment: Segment, counter: Counter, limit: number): string[] {
  if (counter.length(segment.text) <= limit) return [segment.text];
  return counter.split(segment.text, limit);
}

function mergeSegments(
  segments: Segment[],
  policy: ChunkPolicy,
  counter: Counter,
): Array<{ text: string; group: number }> {
  const state: MergeState = {
    policy,
    counter,
    chunks: [],
    current: [],
    currentLength: 0,
    lastKind: null,
    group: 0,
  };
  const overlapUnit =
    policy.overlapSize ??
    (policy.overlapRatio > 0 ? Math.floor(policy.chunkSize * policy.overlapRatio) : 0);

  const startChunk = (segment: Segment): void => {
    const previous = state.chunks[state.chunks.length - 1];
    if (
      overlapUnit > 0 &&
      previous !== undefined &&
      previous.group === state.group &&
      state.lastKind === 'text' &&
      segment.kind === 'text'
    ) {
      const tail = counter.tail(previous.text, overlapUnit);
      const tailLength = tail.length > 0 ? counter.length(tail) : 0;
      if (
        tailLength > 0 &&
        tailLength + counter.length(segment.text) <= policy.chunkSize &&
        !segment.text.startsWith(tail)
      ) {
        state.current.push({ text: tail, kind: 'text' });
        state.currentLength += tailLength;
      }
    }
    state.current.push(segment);
    state.currentLength += counter.length(segment.text);
  };

  for (const segment of segments) {
    if (segment.kind === 'custom') {
      flush(state);
      state.lastKind = null;
      state.group += 1;
      continue;
    }
    const length = counter.length(segment.text);
    if (isAtomic(segment)) {
      flush(state);
      for (const piece of buildSingleSegment(segment, counter, policy.chunkSize)) {
        state.chunks.push({ text: piece, group: state.group });
        state.lastKind = segment.kind;
      }
      continue;
    }
    if (length > policy.chunkSize) {
      flush(state);
      for (const piece of buildSingleSegment(segment, counter, policy.chunkSize)) {
        state.current.push({ text: piece, kind: 'text' });
        state.currentLength += counter.length(piece);
        flush(state);
      }
      continue;
    }
    const separatorLength = state.current.length > 0 ? 1 : 0;
    const candidate = state.currentLength + separatorLength + length;
    if (state.current.length > 0 && candidate > policy.chunkSize) {
      flush(state);
      startChunk(segment);
      continue;
    }
    if (state.current.length === 0) {
      startChunk(segment);
    } else {
      state.current.push(segment);
      state.currentLength = candidate;
    }
  }
  flush(state);
  return state.chunks;
}

/** 小于 minSize 的块优先与后块合并，其次与前块合并，避免产生孤立碎片。 */
function coalesceSmall(
  chunks: Array<{ text: string; group: number }>,
  policy: ChunkPolicy,
  counter: Counter,
): string[] {
  if (chunks.length <= 1) return chunks.map((chunk) => chunk.text);
  const result: Array<{ text: string; group: number }> = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    if (counter.length(chunk.text) >= policy.minSize) {
      result.push(chunk);
      continue;
    }
    const next = chunks[index + 1];
    if (
      next !== undefined &&
      next.group === chunk.group &&
      counter.length(chunk.text) + 1 + counter.length(next.text) <= policy.chunkSize
    ) {
      result.push({ ...chunk, text: `${chunk.text}\n${next.text}` });
      index += 1;
      continue;
    }
    const previous = result[result.length - 1];
    if (
      previous !== undefined &&
      previous.group === chunk.group &&
      counter.length(previous.text) + 1 + counter.length(chunk.text) <= policy.chunkSize
    ) {
      result[result.length - 1] = {
        ...previous,
        text: `${previous.text}\n${chunk.text}`,
      };
      continue;
    }
    result.push(chunk);
  }
  return result.map((chunk) => chunk.text);
}

interface MarkdownParagraphBlock {
  kind: 'text' | 'code';
  text: string;
}

interface MarkdownParagraphGroup {
  headingPath: string[];
  blocks: MarkdownParagraphBlock[];
}

/**
 * Paragraph mode keeps Markdown heading boundaries visible in the stored chunks.
 * A heading path is repeated when a section is split, so every chunk remains
 * independently understandable without changing the source text.
 */
function parseMarkdownParagraphGroups(
  text: string,
  paragraphDeep: number,
): MarkdownParagraphGroup[] | null {
  const lines = text.split('\n');
  const groups: MarkdownParagraphGroup[] = [];
  let headingPath: string[] = [];
  let current: MarkdownParagraphGroup | null = null;
  let textLines: string[] = [];
  let hasHeading = false;

  const ensureCurrent = (): MarkdownParagraphGroup => {
    current ??= { headingPath: [...headingPath], blocks: [] };
    return current;
  };
  const flushText = (): void => {
    const value = textLines.join('\n').trim();
    textLines = [];
    if (value) ensureCurrent().blocks.push({ kind: 'text', text: value });
  };
  const flushGroup = (): void => {
    flushText();
    if (current?.blocks.length) groups.push(current);
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const heading = /^(#{1,6})\s+.+$/.exec(line);
    if (heading) {
      hasHeading = true;
      flushGroup();
      const level = heading[1]!.length;
      if (level <= paragraphDeep) {
        headingPath = headingPath.slice(0, level - 1);
        headingPath[level - 1] = line.trim();
      } else {
        textLines.push(line);
      }
      continue;
    }

    const fence = /^(```|~~~)/.exec(line.trim());
    if (fence) {
      flushGroup();
      const codeLines = [line];
      index += 1;
      while (index < lines.length) {
        const codeLine = lines[index]!;
        codeLines.push(codeLine);
        index += 1;
        if (codeLine.trim().startsWith(fence[1]!)) break;
      }
      index -= 1;
      ensureCurrent().blocks.push({ kind: 'code', text: codeLines.join('\n') });
      flushGroup();
      continue;
    }
    textLines.push(line);
  }
  flushGroup();
  return hasHeading ? groups : null;
}

function renderMarkdownParagraphGroup(group: MarkdownParagraphGroup): string {
  const prefix = group.headingPath.join('\n');
  const body = group.blocks
    .map((block) => block.text)
    .join('\n\n')
    .trim();
  return [prefix, body].filter(Boolean).join('\n');
}

function splitMarkdownParagraphGroup(
  group: MarkdownParagraphGroup,
  policy: ChunkPolicy,
  counter: Counter,
): string[] {
  const rendered = renderMarkdownParagraphGroup(group);
  if (counter.length(rendered) <= policy.chunkSize) return [rendered];

  const prefix = group.headingPath.join('\n');
  const prefixLength = prefix ? counter.length(prefix) + 1 : 0;
  const bodyBudget = Math.max(1, policy.chunkSize - prefixLength);
  const units = group.blocks.flatMap((block) =>
    block.kind === 'code' ? [block.text] : block.text.split(/\n{2,}/).filter(Boolean),
  );
  const chunks: string[] = [];
  let body = '';

  const push = (): void => {
    const value = body.trim();
    body = '';
    if (!value) return;
    const chunk = [prefix, value].filter(Boolean).join('\n');
    if (counter.length(chunk) <= policy.chunkSize) {
      chunks.push(chunk);
      return;
    }
    const bodyPieces = counter.split(value, bodyBudget);
    const budgetedPrefixes = bodyPieces.map((piece) => [prefix, piece].filter(Boolean).join('\n'));
    chunks.push(...budgetedPrefixes);
  };

  for (const unit of units) {
    const candidate = body ? `${body}\n\n${unit}` : unit;
    if (counter.length(candidate) <= bodyBudget) {
      body = candidate;
      continue;
    }
    push();
    if (counter.length(unit) <= bodyBudget) {
      body = unit;
      continue;
    }
    const pieces = counter.split(unit, bodyBudget);
    for (const piece of pieces.slice(0, -1)) {
      chunks.push([prefix, piece].filter(Boolean).join('\n'));
    }
    body = pieces.at(-1) ?? '';
  }
  push();
  return chunks;
}

export function chunkText(input: { text: string; policy: ChunkPolicy }): ChunkOutput {
  const policy = input.policy;
  validatePolicy(policy);
  const normalized = normalizeChunkText(input.text);
  if (normalized.trim().length === 0) return { chunks: [] };

  const counter = createCounter(policy.lengthUnit);
  if ((policy.mode === 'auto' || policy.mode === 'paragraph') && policy.customRegs.length === 0) {
    const groups = parseMarkdownParagraphGroups(normalized, policy.paragraphDeep);
    if (groups) {
      const chunks = groups.flatMap((group) => splitMarkdownParagraphGroup(group, policy, counter));
      if (chunks.length > policy.maxChunks) {
        throw chunkLimitError({
          maxChunks: policy.maxChunks,
          actual: chunks.length,
          chunkSize: policy.chunkSize,
        });
      }
      return {
        chunks: chunks.map((text, index) => ({
          index,
          text,
          contentHash: contentHashOfChunk(text),
        })),
      };
    }
  }
  const segments = buildSegments(normalized, {
    customRegs: policy.customRegs,
    paragraphDeep: policy.paragraphDeep,
  });
  const expanded = expandOversized(segments, policy, counter);
  const merged = coalesceSmall(mergeSegments(expanded, policy, counter), policy, counter);
  const chunks = merged.filter((chunk) => chunk.trim().length > 0);
  if (chunks.length > policy.maxChunks) {
    throw chunkLimitError({
      maxChunks: policy.maxChunks,
      actual: chunks.length,
      chunkSize: policy.chunkSize,
    });
  }
  return {
    chunks: chunks.map((text, index) => ({
      index,
      text,
      contentHash: contentHashOfChunk(text),
    })),
  };
}
