import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHUNK_POLICY,
  S5ChunkingSettingsSchema,
  chunkText,
  toChunkPolicy,
} from '../../src/index';

describe('TEST-PARSE-003-BLOCK deterministic chunk settings', () => {
  it('maps auto, intelligent, custom, paragraph, size and char settings deterministically', () => {
    const auto = toChunkPolicy({ trainingType: 'chunk', chunkSettingMode: 'auto' });
    expect(auto).toEqual(DEFAULT_CHUNK_POLICY);
    const intelligent = toChunkPolicy({
      trainingType: 'qa',
      chunkSettingMode: 'intelligent',
      chunkSplitMode: 'paragraph',
      paragraphChunkDeep: 3,
      paragraphChunkMinSize: 200,
    });
    expect(intelligent.paragraphDeep).toBe(3);
    expect(intelligent.minSize).toBe(200);
    const custom = toChunkPolicy({
      trainingType: 'qa',
      chunkSettingMode: 'custom',
      chunkSplitMode: 'char',
      chunkSize: 512,
      chunkSplitter: '\\n---\\n\n\\nSECTION\\n',
    });
    expect(custom).toMatchObject({
      mode: 'custom',
      lengthUnit: 'char',
      chunkSize: 512,
      overlapRatio: 0.15,
      forceSplit: true,
      maxChunks: 50_000,
    });
    expect(custom.customRegs).toEqual(['\\n---\\n', '\\nSECTION\\n']);
    const paragraph = toChunkPolicy({
      trainingType: 'chunk',
      chunkSettingMode: 'custom',
      chunkSplitMode: 'paragraph',
      chunkSize: 300,
      paragraphChunkDeep: 0,
    });
    expect(paragraph.mode).toBe('paragraph');
    expect(paragraph.paragraphDeep).toBe(1);
  });

  it('rejects unknown values and invalid custom combinations', () => {
    expect(
      S5ChunkingSettingsSchema.safeParse({
        trainingType: 'unknown',
        chunkSettingMode: 'auto',
      }).success,
    ).toBe(false);
    expect(() =>
      toChunkPolicy({
        trainingType: 'chunk',
        chunkSettingMode: 'custom',
      }),
    ).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_VALIDATION_FAILED' }),
        }),
      }),
    );
    expect(() =>
      toChunkPolicy({
        trainingType: 'chunk',
        chunkSettingMode: 'custom',
        chunkSize: 63,
      }),
    ).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_VALIDATION_FAILED' }),
        }),
      }),
    );
    expect(() =>
      toChunkPolicy({
        trainingType: 'chunk',
        chunkSettingMode: 'auto',
        unexpected: true,
      } as never),
    ).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_VALIDATION_FAILED' }),
        }),
      }),
    );
  });

  it('produces byte-identical chunks for the same settings and text', () => {
    const settings = {
      trainingType: 'chunk' as const,
      chunkSettingMode: 'custom' as const,
      chunkSplitMode: 'size' as const,
      chunkSize: 80,
      chunkTriggerMinSize: 10,
    };
    const policy = toChunkPolicy(settings);
    const text = 'S5 deterministic text. '.repeat(30);
    const first = chunkText({ text, policy });
    const second = chunkText({ text, policy });
    expect(second).toEqual(first);
    expect(first.chunks.length).toBeGreaterThan(1);
  });
});
