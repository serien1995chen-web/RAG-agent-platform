/**
 * @kb/chunk 长度计数：token 模式使用与模型一致的 gpt-tokenizer，char 模式按 Unicode code point。
 */
import { decode, encode } from 'gpt-tokenizer';

export type LengthUnit = 'char' | 'token';

export interface Counter {
  /** 文本长度（按当前单位）。 */
  length(text: string): number;
  /** 取末尾不超过 limit 个单位的片段（用于 overlap）。 */
  tail(text: string, limit: number): string;
}

export function countCodePoints(text: string): number {
  return [...text].length;
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
