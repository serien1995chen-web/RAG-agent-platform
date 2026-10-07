import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict.js';

let cached: Jieba | undefined;

function jieba(): Jieba {
  cached ??= Jieba.withDict(dict);
  return cached;
}

/** NFKC 规范化 → trim → 连续空白折叠为单个空格（设计文档 10.6 / 6.1.3）。 */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

/**
 * jieba 搜索模式分词；过滤空 token，以单个 ASCII 空格连接。
 * 不做未登记的同义词/停用词扩展（U-17 触发验证点）。
 */
export function tokenizeForSearch(text: string): string {
  const normalized = normalizeText(text);
  if (normalized.length === 0) return '';
  return jieba()
    .cutForSearch(normalized, true)
    .filter((token) => token.trim().length > 0)
    .join(' ');
}
