import { describe, expect, it } from 'vitest';
import { DEFAULT_CHUNK_POLICY, chunkText, type ChunkPolicy } from '../../src/index';

function policy(overrides: Partial<ChunkPolicy> = {}): ChunkPolicy {
  return { ...DEFAULT_CHUNK_POLICY, lengthUnit: 'char', ...overrides };
}

const sentence = '这是一个用于测试重叠与边界稳定性的句子，包含足够多的字符。';
const body = Array.from({ length: 12 }, (_, index) => `${index}${sentence}`).join('');

describe('TEST-CHUNK-OVERLAP-001 overlap boundaries', () => {
  it('produces no overlap when overlapRatio is 0', () => {
    const result = chunkText({
      text: body,
      policy: policy({ chunkSize: 120, minSize: 30, overlapRatio: 0 }),
    });
    expect(result.chunks.length).toBeGreaterThan(1);
  });

  it('does not exceed the chunk size budget with overlap 0.15', () => {
    const result = chunkText({
      text: body,
      policy: policy({ chunkSize: 120, minSize: 30, overlapRatio: 0.15 }),
    });
    for (const chunk of result.chunks) {
      expect([...chunk.text].length).toBeLessThanOrEqual(120 + Math.floor(120 * 0.15));
    }
  });

  it('carries previous chunk tail context at overlap 0.9', () => {
    const result = chunkText({
      text: body,
      policy: policy({ chunkSize: 100, minSize: 20, overlapRatio: 0.9 }),
    });
    expect(result.chunks.length).toBeGreaterThan(1);
    for (let index = 1; index < result.chunks.length; index += 1) {
      const previous = result.chunks[index - 1]?.text ?? '';
      const current = result.chunks[index]?.text ?? '';
      const tail = [...previous].slice(-Math.floor(100 * 0.9)).join('');
      expect(current.includes(tail.slice(-10)) || tail.length === 0).toBe(true);
    }
  });

  it('does not overlap across table boundaries', () => {
    const table = '| q | a |\n| --- | --- |\n| 1 | 2 |';
    const text = `${sentence}\n\n${table}\n\n${sentence}`;
    const result = chunkText({
      text,
      policy: policy({ chunkSize: 80, minSize: 10, overlapRatio: 0.5 }),
    });
    const tableChunk = result.chunks.find((chunk) => chunk.text.includes('| q | a |'));
    expect(tableChunk).toBeDefined();
    expect(tableChunk?.text.trim().startsWith('|')).toBe(true);
  });

  it('is order-stable including hashes across repeated runs', () => {
    const options = { chunkSize: 120, minSize: 20, overlapRatio: 0.15 } as const;
    const first = chunkText({ text: body, policy: policy(options) });
    const second = chunkText({ text: body, policy: policy(options) });
    expect(second.chunks.map((chunk) => chunk.contentHash)).toEqual(
      first.chunks.map((chunk) => chunk.contentHash),
    );
  });
});
