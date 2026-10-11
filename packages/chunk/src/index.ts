/**
 * @kb/chunk — 确定性切分、重叠边界与 ChunkPolicy 算法（CR-FEATURE-05，设计文档 9.8.1）。
 * 算法实现阶段必须保证相同输入与策略产生完全相同的 chunk 序列。
 */
import { chunkText as runChunk } from './chunker';
import type { ChunkInput, ChunkOutput } from './types';

export const PACKAGE_NAME = '@kb/chunk' as const;

export { DEFAULT_CHUNK_POLICY, countCodePoints, contentHashOfChunk } from './types';
export type { ChunkInput, ChunkItem, ChunkOutput, ChunkPolicy } from './types';
export { createCounter, countTokens } from './token-count';
export type { Counter, LengthUnit } from './token-count';
export { buildSegments, normalizeChunkText } from './paragraph';
export type { Segment, SegmentKind, SegmentOptions } from './paragraph';
export { CHUNK_LIMIT_ERROR_CODE, chunkLimitError } from './chunker';

/** 确定性切分入口：空输入返回空数组；上限越界抛 501053。 */
export function chunkText(input: ChunkInput): ChunkOutput {
  return runChunk(input);
}
