import { describe, expect, it } from 'vitest';
import { ChunkingSettingsSchema } from '@kb/contracts';
import { S5ChunkingSettingsSchema } from '../../src/index';

describe('KB import settings parity audit', () => {
  it('uses FastGPT block-trigger boundaries', () => {
    expect(
      S5ChunkingSettingsSchema.safeParse({
        trainingType: 'chunk',
        chunkSettingMode: 'custom',
        chunkTriggerType: 'minSize',
        chunkTriggerMinSize: 99,
        chunkSize: 1000,
      }).success,
    ).toBe(false);
    expect(
      S5ChunkingSettingsSchema.safeParse({
        trainingType: 'chunk',
        chunkSettingMode: 'custom',
        chunkTriggerType: 'minSize',
        chunkTriggerMinSize: 100,
        chunkSize: 1000,
      }).success,
    ).toBe(true);
  });

  it('requires paragraph depth to be an integer within 1..8', () => {
    expect(
      S5ChunkingSettingsSchema.safeParse({
        trainingType: 'qa',
        chunkSettingMode: 'custom',
        chunkSplitMode: 'paragraph',
        chunkSize: 8000,
        paragraphChunkDeep: 0,
      }).success,
    ).toBe(false);
    expect(
      S5ChunkingSettingsSchema.safeParse({
        trainingType: 'qa',
        chunkSettingMode: 'custom',
        chunkSplitMode: 'paragraph',
        chunkSize: 8000,
        paragraphChunkDeep: 8,
      }).success,
    ).toBe(true);
  });

  it('uses a 1000-token minimum for QA source chunks', () => {
    expect(
      S5ChunkingSettingsSchema.safeParse({
        trainingType: 'qa',
        chunkSettingMode: 'custom',
        chunkSplitMode: 'size',
        chunkSize: 999,
      }).success,
    ).toBe(false);
    expect(
      S5ChunkingSettingsSchema.safeParse({
        trainingType: 'qa',
        chunkSettingMode: 'custom',
        chunkSplitMode: 'size',
        chunkSize: 1000,
      }).success,
    ).toBe(true);
  });

  it('allows FastGPT paragraph AI controls for QA without weakening chunk bounds', () => {
    expect(
      ChunkingSettingsSchema.safeParse({
        trainingType: 'qa',
        chunkSettingMode: 'custom',
        chunkSplitMode: 'paragraph',
        paragraphChunkAIMode: 'force',
        paragraphChunkDeep: 8,
        paragraphChunkMinSize: 100,
        chunkSize: 8_000,
      }).success,
    ).toBe(true);
    expect(
      S5ChunkingSettingsSchema.safeParse({
        trainingType: 'qa',
        chunkSettingMode: 'custom',
        chunkSplitMode: 'paragraph',
        paragraphChunkAIMode: 'auto',
        paragraphChunkDeep: 5,
        chunkSize: 1_000,
      }).success,
    ).toBe(true);
  });
});
