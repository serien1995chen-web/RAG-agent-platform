/**
 * @kb/chunk 冻结类型、默认策略、稳定哈希与长度计数（设计文档 9.8.1）。
 * 作为 @kb/chunk 的叶子模块：定义 ChunkPolicy 与 token/char 两种计数，
 * 不 import 任何本地模块，供 chunker/paragraph/index 复用，避免 barrel 循环依赖。
 */
import { createHash } from 'node:crypto';
import { decode, encode } from 'gpt-tokenizer';

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

export type LengthUnit = 'char' | 'token';

export interface Counter {
  /** 文本长度（按当前单位）。 */
  length(text: string): number;
  /** 取末尾不超过 limit 个单位的片段（用于 overlap）。 */
  tail(text: string, limit: number): string;
}

function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return encode(text).length;
}

export function createCounter(unit: LengthUnit): Counter {
  if (unit === 'char') {
    return {
      length: countCodePoints,
      tail: (text, limit) => (limit <= 0 ? '' : [...text].slice(-limit).join('')),
    };
  }
  return {
    length: countTokens,
    tail: (text, limit) => {
      if (limit <= 0 || text.length === 0) return '';
      const tokens = encode(text);
      return decode(tokens.slice(-limit));
    },
  };
}

export { countTokens };
