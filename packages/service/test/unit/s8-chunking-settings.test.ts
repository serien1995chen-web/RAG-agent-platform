import { describe, expect, it } from 'vitest';
import { ChunkingSettingsSchema } from '@kb/contracts';

describe('TEST-PARSE-005-BLOCK chunking settings matrix', () => {
  it('accepts the complete chunk settings shape and strict unknown rejection', () => {
    const settings = {
      trainingType: 'chunk',
      chunkTriggerType: 'minSize',
      chunkTriggerMinSize: 100,
      chunkSettingMode: 'custom',
      chunkSplitMode: 'paragraph',
      paragraphChunkAIMode: 'auto',
      paragraphChunkDeep: 2,
      paragraphChunkMinSize: 200,
      chunkSize: 800,
      chunkSplitter: '\n\n',
      indexSize: 600,
      dataEnhanceCollectionName: true,
      imageIndex: true,
      autoIndexes: true,
      indexPrefixTitle: true,
      qaPrompt: undefined,
    };
    expect(ChunkingSettingsSchema.safeParse(settings).success).toBe(true);
    expect(ChunkingSettingsSchema.safeParse({ ...settings, unknown: true }).success).toBe(false);
  });

  it('rejects invalid settings combinations with 422 validation', () => {
    for (const settings of [
      { trainingType: 'chunk', chunkSettingMode: 'custom' },
      {
        trainingType: 'chunk',
        chunkSettingMode: 'custom',
        chunkSize: 100,
        chunkTriggerMinSize: 101,
      },
      {
        trainingType: 'chunk',
        chunkSettingMode: 'auto',
        chunkSplitMode: 'size',
        paragraphChunkAIMode: 'force',
      },
      {
        trainingType: 'qa',
        chunkSettingMode: 'auto',
        autoIndexes: true,
      },
      {
        trainingType: 'template',
        chunkSettingMode: 'auto',
        imageIndex: true,
      },
      {
        trainingType: 'chunk',
        chunkSettingMode: 'auto',
        qaPrompt: 'only qa',
      },
    ]) {
      expect(ChunkingSettingsSchema.safeParse(settings).success).toBe(false);
    }
  });

  it('allows paragraph-only fields only in paragraph mode', () => {
    expect(
      ChunkingSettingsSchema.safeParse({
        trainingType: 'chunk',
        chunkSettingMode: 'custom',
        chunkSize: 500,
        chunkSplitMode: 'paragraph',
        paragraphChunkAIMode: 'force',
        paragraphChunkMinSize: 100,
      }).success,
    ).toBe(true);
    expect(
      ChunkingSettingsSchema.safeParse({
        trainingType: 'chunk',
        chunkSettingMode: 'custom',
        chunkSize: 500,
        chunkSplitMode: 'size',
        paragraphChunkMinSize: 100,
      }).success,
    ).toBe(false);
  });
});
