import { describe, expect, it } from 'vitest';
import {
  buildQaDedupKey,
  dedupeQaItems,
  DEFAULT_QA_PROMPT,
  DEFAULT_QA_PROMPT_HASH,
  normalizeQaText,
  parseQaOutput,
} from '../../src/index';

const CHUNK_HASH = 'abc123';

describe('TEST-QA-SCHEMA-001 QA output schema', () => {
  it('parses Q<i>: / A<i>: blocks in order', () => {
    const content = 'Q1: 问题一\nA1: 答案一\nQ2: 问题二\nA2: 答案二';
    const items = parseQaOutput(content, CHUNK_HASH);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ q: '问题一', a: '答案一', sourceChunkHash: CHUNK_HASH });
    expect(items[1]?.q).toBe('问题二');
  });

  it('supports fullwidth colons and multi-line answers', () => {
    const content = 'Q1：问题\nA1：第一行\n第二行';
    const items = parseQaOutput(content, CHUNK_HASH);
    expect(items).toHaveLength(1);
    expect(items[0]?.a).toBe('第一行 第二行');
  });

  it('returns empty items for unmatched output', () => {
    expect(parseQaOutput('没有结构化内容', CHUNK_HASH)).toEqual([]);
    expect(parseQaOutput('', CHUNK_HASH)).toEqual([]);
  });

  it('repairs malformed JSON fragments via jsonrepair', () => {
    const content = '[{"q": "问题", "a": "答案",},]';
    const items = parseQaOutput(content, CHUNK_HASH);
    expect(items).toHaveLength(1);
    expect(items[0]?.q).toBe('问题');
  });

  it('registers the self-authored default template hash', () => {
    expect(DEFAULT_QA_PROMPT).toContain('问答对');
    expect(DEFAULT_QA_PROMPT_HASH).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('TEST-QA-DEDUP-001 dedup key and per-chunk cap', () => {
  it('is stable under NFKC normalization and trimming', () => {
    const first = buildQaDedupKey('  问题 ', ' 答案 ');
    const second = buildQaDedupKey('问题', '答案');
    expect(first).toBe(second);
    expect(first).toMatch(/^qa:[0-9a-f]{64}$/);
    expect(normalizeQaText(' ＡＢＣ ')).toBe('ABC');
  });

  it('keeps the first occurrence and counts duplicates', () => {
    const items = [
      { q: '问题', a: '答案', sourceChunkHash: CHUNK_HASH },
      { q: '问题', a: '答案', sourceChunkHash: CHUNK_HASH },
      { q: '问题2', a: '答案2', sourceChunkHash: CHUNK_HASH },
    ];
    const outcome = dedupeQaItems(items, 5);
    expect(outcome.items).toHaveLength(2);
    expect(outcome.duplicates).toBe(1);
  });

  it('enforces maxQaPerChunk per source chunk and counts overflow', () => {
    const items = Array.from({ length: 7 }, (_, index) => ({
      q: '问题' + String(index),
      a: '答案' + String(index),
      sourceChunkHash: CHUNK_HASH,
    }));
    const outcome = dedupeQaItems(items, 5);
    expect(outcome.items).toHaveLength(5);
    expect(outcome.overLimit).toBe(2);
  });
});
