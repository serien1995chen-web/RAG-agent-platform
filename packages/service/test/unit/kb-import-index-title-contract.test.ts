import { describe, expect, it } from 'vitest';
import { ChunkingSettingsSchema } from '@kb/contracts';

describe('FastGPT import index-title parity contract', () => {
  it('keeps indexPrefixTitle independent when autoIndexes is disabled during chunking', () => {
    expect(
      ChunkingSettingsSchema.safeParse({
        trainingType: 'chunk',
        chunkSettingMode: 'auto',
        autoIndexes: false,
        indexPrefixTitle: true,
        imageIndex: false,
      }).success,
    ).toBe(true);
  });

  it('accepts title indexing in QA mode without supplemental or image indexes', () => {
    expect(
      ChunkingSettingsSchema.safeParse({
        trainingType: 'qa',
        chunkSettingMode: 'auto',
        autoIndexes: false,
        indexPrefixTitle: true,
        imageIndex: false,
      }).success,
    ).toBe(true);
  });

  it('rejects supplemental and image indexes when QA processing is selected', () => {
    expect(
      ChunkingSettingsSchema.safeParse({
        trainingType: 'qa',
        chunkSettingMode: 'auto',
        autoIndexes: true,
      }).success,
    ).toBe(false);
    expect(
      ChunkingSettingsSchema.safeParse({
        trainingType: 'qa',
        chunkSettingMode: 'auto',
        imageIndex: true,
      }).success,
    ).toBe(false);
  });
});
