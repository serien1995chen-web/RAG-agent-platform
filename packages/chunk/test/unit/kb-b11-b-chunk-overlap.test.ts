import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHUNK_POLICY,
  chunkText,
  countCodePoints,
  type ChunkPolicy,
} from '../../src/index';

const corpus = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', '..', '..', 'test', 'fixtures', 'b11-b', 'corpus.json'),
    'utf8',
  ),
) as Record<string, string>;

function policy(overrides: Partial<ChunkPolicy> = {}): ChunkPolicy {
  return {
    ...DEFAULT_CHUNK_POLICY,
    lengthUnit: 'char',
    chunkSize: 160,
    minSize: 32,
    maxSize: 8000,
    overlapRatio: 0,
    ...overrides,
  };
}

describe('L1-B11-B-PARSE-003 overlap and capacity', () => {
  it('L1-B11-B-PARSE-003-P06 creates deterministic non-zero overlap within the chunk budget', () => {
    const text = `${corpus.longParagraph}`.repeat(8);
    const first = chunkText({ text, policy: policy({ overlapRatio: 0.2 }) });
    const second = chunkText({ text, policy: policy({ overlapRatio: 0.2 }) });
    expect(first).toEqual(second);
    expect(first.chunks.length).toBeGreaterThan(1);
    for (const chunk of first.chunks) {
      expect(countCodePoints(chunk.text)).toBeLessThanOrEqual(160);
    }
  });

  it('L1-B11-B-PARSE-003-P07 does not overlap across custom separator boundaries', () => {
    const result = chunkText({
      text: '第一块内容足够长以形成独立文本。\n---\n第二块内容同样足够长以形成独立文本。',
      policy: policy({
        mode: 'custom',
        overlapRatio: 0.5,
        customRegs: ['\\n---\\n'],
      }),
    });
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[1]?.text).not.toContain('第一块');
  });

  it('L1-B11-B-PARSE-003-N05 splits an oversized Markdown table without losing content', () => {
    const result = chunkText({
      text: corpus.oversizedTable!,
      policy: policy({ chunkSize: 160, minSize: 1, overlapRatio: 0 }),
    });
    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(countCodePoints(chunk.text)).toBeLessThanOrEqual(160);
    }
    expect(result.chunks.map((chunk) => chunk.text).join('')).toContain('第三行');
  });

  it('L1-B11-B-PARSE-003-N06 handles a long paragraph without an explicit separator', () => {
    const text = corpus.longParagraph!.repeat(100);
    const result = chunkText({
      text,
      policy: policy({ chunkSize: 64, minSize: 1, maxChunks: 20_000 }),
    });
    expect(result.chunks.length).toBeGreaterThan(10);
    expect(result.chunks.every((chunk) => chunk.text.trim().length > 0)).toBe(true);
    for (const chunk of result.chunks) {
      expect(countCodePoints(chunk.text)).toBeLessThanOrEqual(64);
    }
  });

  it('L1-B11-B-PARSE-003-Q01 remains deterministic across repetitive boundary inputs', () => {
    for (let repetition = 1; repetition <= 20; repetition += 1) {
      const text = `${corpus.mixedMarkdown}${'\n\n短。'.repeat(repetition)}`;
      const options = {
        chunkSize: 96,
        minSize: 8,
        overlapRatio: repetition % 2 === 0 ? 0 : 0.2,
      } as const;
      const first = chunkText({ text, policy: policy(options) });
      const second = chunkText({ text, policy: policy(options) });
      expect(second.chunks.map((chunk) => chunk.contentHash)).toEqual(
        first.chunks.map((chunk) => chunk.contentHash),
      );
      expect(new Set(first.chunks.map((chunk) => chunk.index)).size).toBe(first.chunks.length);
    }
  });
});
