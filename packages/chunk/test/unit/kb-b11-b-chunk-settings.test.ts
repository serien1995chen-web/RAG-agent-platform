import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHUNK_POLICY,
  S5ChunkingSettingsSchema,
  chunkText,
  toChunkPolicy,
  type ChunkPolicy,
} from '../../src/index';

function policy(overrides: Partial<ChunkPolicy> = {}): ChunkPolicy {
  return { ...DEFAULT_CHUNK_POLICY, lengthUnit: 'char', ...overrides };
}

describe('L1-B11-B-PARSE-003 settings and boundaries', () => {
  it('L1-B11-B-PARSE-003-P01/P06 uses FastGPT final overlap semantics for chunk and QA', () => {
    expect(toChunkPolicy({ trainingType: 'chunk', chunkSettingMode: 'auto' }).overlapRatio).toBe(
      0.2,
    );
    expect(toChunkPolicy({ trainingType: 'qa', chunkSettingMode: 'auto' }).overlapRatio).toBe(0);
  });

  it('L1-B11-B-PARSE-003-P02/P03/P04/P05 accepts auto, intelligent, paragraph, size and multi-separator settings', () => {
    expect(
      S5ChunkingSettingsSchema.safeParse({
        trainingType: 'chunk',
        chunkSettingMode: 'intelligent',
        chunkSize: 512,
      }).success,
    ).toBe(true);
    const paragraph = toChunkPolicy({
      trainingType: 'chunk',
      chunkSettingMode: 'custom',
      chunkSplitMode: 'paragraph',
      chunkSize: 512,
      paragraphChunkAIMode: 'auto',
      paragraphChunkDeep: 5,
      paragraphChunkMinSize: 100,
    });
    expect(paragraph).toMatchObject({
      mode: 'paragraph',
      paragraphDeep: 5,
      minSize: 100,
    });
    const custom = toChunkPolicy({
      trainingType: 'chunk',
      chunkSettingMode: 'custom',
      chunkSplitMode: 'char',
      chunkSize: 512,
      chunkSplitter: '\\n---\\n\n\\nSECTION\\n',
    });
    expect(custom.customRegs).toEqual(['\\n---\\n', '\\nSECTION\\n']);
  });

  it('L1-B11-B-PARSE-003-P06 accepts a bounded public overlap value', () => {
    expect(
      S5ChunkingSettingsSchema.safeParse({
        trainingType: 'chunk',
        chunkSettingMode: 'custom',
        chunkSize: 512,
        overlap: 100,
      }).success,
    ).toBe(true);
  });

  it('L1-B11-B-PARSE-003-N01/N02 rejects illegal sizes, overlap and trigger combinations', () => {
    for (const invalid of [
      policy({ chunkSize: 63 }),
      policy({ chunkSize: 100_001 }),
      policy({ minSize: 513, chunkSize: 512 }),
      policy({ overlapRatio: -0.01 }),
      policy({ overlapRatio: 1 }),
      policy({ paragraphDeep: 0 }),
    ]) {
      expect(() => chunkText({ text: '边界文本。', policy: invalid })).toThrow();
    }
    expect(() =>
      toChunkPolicy({
        trainingType: 'chunk',
        chunkSettingMode: 'custom',
        chunkSize: 64,
        chunkTriggerMinSize: 65,
      }),
    ).toThrow();
  });

  it('L1-B11-B-PARSE-003-N03 rejects empty, duplicate and excessive separators', () => {
    const invalidSplitters = ['\\n||\\n', 'A\nA', 'A\nB\nC\nD\nE\nF', `${'X'.repeat(201)}\nY`];
    for (const chunkSplitter of invalidSplitters) {
      expect(
        S5ChunkingSettingsSchema.safeParse({
          trainingType: 'chunk',
          chunkSettingMode: 'custom',
          chunkSize: 512,
          chunkSplitMode: 'char',
          chunkSplitter,
        }).success,
        chunkSplitter.slice(0, 80),
      ).toBe(false);
    }
  });

  it('L1-B11-B-PARSE-003-N04 preserves emoji, combining marks and surrogate pairs', () => {
    const text = `${'😀e\u0301'.repeat(180)}尾`;
    const first = chunkText({
      text,
      policy: policy({ chunkSize: 64, minSize: 1, overlapRatio: 0 }),
    });
    const second = chunkText({
      text,
      policy: policy({ chunkSize: 64, minSize: 1, overlapRatio: 0 }),
    });
    expect(second).toEqual(first);
    expect(first.chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(first.chunks.every((chunk) => !chunk.text.includes('\uFFFD'))).toBe(true);
  });

  it('L1-B11-B-PARSE-003-N05 does not silently coerce an unknown mode to defaults', () => {
    expect(
      S5ChunkingSettingsSchema.safeParse({
        trainingType: 'chunk',
        chunkSettingMode: 'unknown',
      }).success,
    ).toBe(false);
  });
});
