/**
 * @kb/chunk 冻结类型、默认策略与稳定哈希（设计文档 9.8.1）。
 */
import { createHash } from 'node:crypto';

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

/** 稳定内容哈希：同一 chunk 文本 → 同一哈希。 */
export function contentHashOfChunk(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
