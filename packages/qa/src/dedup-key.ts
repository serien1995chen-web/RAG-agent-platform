/**
 * @kb/qa 规范化与去重键：qa:sha256(NFKC(trim(q)) + NUL + NFKC(trim(a)))（设计文档 9.9.1）。
 */
import { createHash } from 'node:crypto';

export function normalizeQaText(text: string): string {
  return text.normalize('NFKC').trim();
}

export function buildQaDedupKey(q: string, a: string): string {
  const payload = `${normalizeQaText(q)}\u0000${normalizeQaText(a)}`;
  const hash = createHash('sha256').update(payload).digest('hex');
  return `qa:${hash}`;
}
