import { createHash } from 'node:crypto';

export function normalizeQaText(text: string): string {
  return text.normalize('NFKC').trim();
}

/** 与设计文档 9.9.1 的 QA 去重键一致：qa:sha256(NFKC(q)\0NFKC(a))。 */
export function buildQaDedupKey(q: string, a: string): string {
  const hash = createHash('sha256')
    .update(`${normalizeQaText(q)}\u0000${normalizeQaText(a)}`)
    .digest('hex');
  return `qa:${hash}`;
}
