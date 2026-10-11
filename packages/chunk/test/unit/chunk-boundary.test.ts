import { describe, expect, it } from 'vitest';
import { DEFAULT_CHUNK_POLICY, chunkText, type ChunkPolicy } from '../../src/index';

function policy(overrides: Partial<ChunkPolicy> = {}): ChunkPolicy {
  return { ...DEFAULT_CHUNK_POLICY, lengthUnit: 'char', ...overrides };
}

describe('TEST-CHUNK-BOUNDARY-001 deterministic boundaries', () => {
  it('returns empty chunks for empty or whitespace input', () => {
    expect(chunkText({ text: '', policy: policy() }).chunks).toEqual([]);
    expect(chunkText({ text: '   \n\n  ', policy: policy() }).chunks).toEqual([]);
  });

  it('keeps every chunk within maxSize when splitting long text', () => {
    const text = Array.from({ length: 200 }, (_, index) => `句子${index}。`).join('');
    const result = chunkText({
      text,
      policy: policy({ chunkSize: 120, minSize: 20, maxSize: 8000, overlapRatio: 0 }),
    });
    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect([...chunk.text].length).toBeLessThanOrEqual(120);
    }
  });

  it('merges undersized trailing segments instead of emitting tiny chunks', () => {
    const text = 'A'.repeat(90) + '\n\n' + 'B'.repeat(90);
    const result = chunkText({ text, policy: policy({ chunkSize: 200, minSize: 100 }) });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.text).toContain('A'.repeat(90));
    expect(result.chunks[0]?.text).toContain('B'.repeat(90));
  });

  it('hard-splits an oversized single sentence when forceSplit is true', () => {
    const text = '字'.repeat(300);
    const result = chunkText({
      text,
      policy: policy({ chunkSize: 80, minSize: 10, forceSplit: true }),
    });
    expect(result.chunks.length).toBeGreaterThan(1);
    const joined = result.chunks.map((chunk) => chunk.text).join('');
    expect(joined).toBe(text);
  });

  it('throws 501053 for an oversized sentence when forceSplit is false', () => {
    const text = '字'.repeat(300);
    const error = (() => {
      try {
        chunkText({ text, policy: policy({ chunkSize: 80, minSize: 10, forceSplit: false }) });
        return null;
      } catch (thrown) {
        return thrown as { error: { code: number } };
      }
    })();
    expect(error?.error.code).toBe(501053);
  });

  it('throws 501053 when chunk count exceeds maxChunks', () => {
    const text = Array.from({ length: 50 }, () => '段落内容较长需要独立成块').join('\n\n');
    const error = (() => {
      try {
        chunkText({ text, policy: policy({ chunkSize: 64, minSize: 1, maxChunks: 2 }) });
        return null;
      } catch (thrown) {
        return thrown as { error: { code: number } };
      }
    })();
    expect(error?.error.code).toBe(501053);
  });

  it('is deterministic: identical input yields identical chunks and hashes', () => {
    const text = '第一段内容。\n\n第二段内容。\n\n第三段内容。';
    const first = chunkText({ text, policy: policy({ chunkSize: 64, minSize: 1 }) });
    const second = chunkText({ text, policy: policy({ chunkSize: 64, minSize: 1 }) });
    expect(second).toEqual(first);
  });
});
