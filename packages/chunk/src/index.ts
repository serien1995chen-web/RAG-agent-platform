/**
 * @kb/chunk — 确定性切分、重叠边界与 ChunkPolicy 算法（CR-FEATURE-05，设计文档 9.8.1）。
 * 算法实现阶段必须保证相同输入与策略产生完全相同的 chunk 序列。
 */
import { ApiErrorException, createSkeletonError } from '@kb/contracts';

export const PACKAGE_NAME = '@kb/chunk' as const;

export interface ChunkPolicy {
  mode: 'auto' | 'paragraph' | 'custom';
  chunkSize: number;
  minSize: number;
  maxSize: number;
  overlapRatio: number;
  paragraphDeep: number;
  customRegs: string[];
  lengthUnit: 'char' | 'token';
  forceSplit: boolean;
  maxChunks: number;
}

/** 设计文档 9.8.1 冻结的默认值与边界。 */
export const DEFAULT_CHUNK_POLICY: ChunkPolicy = {
  mode: 'auto',
  chunkSize: 1000,
  minSize: 100,
  maxSize: 8000,
  overlapRatio: 0.15,
  paragraphDeep: 5,
  customRegs: [],
  lengthUnit: 'token',
  forceSplit: true,
  maxChunks: 50000,
};

export interface ChunkInput {
  text: string;
  policy: ChunkPolicy;
}

export interface ChunkItem {
  index: number;
  text: string;
  contentHash: string;
}

export interface ChunkOutput {
  chunks: ChunkItem[];
}

export function countCodePoints(text: string): number {
  return [...text].length;
}

/** 骨架期直接拒绝；Phase 4+ 按 9.8.1 实现确定性切分。 */
export function chunkText(_input: ChunkInput): ChunkOutput {
  throw new ApiErrorException(createSkeletonError({ operation: 'chunk' }, 'chunk'));
}
