import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildImportChunkingSettings,
  parseChunkingSettingsDraft,
} from '../../src/forms/s5-model-parse-form';

const root = join(import.meta.dirname, '..', '..', 'src');

function expectSourceContains(source: string, token: string) {
  expect(source.includes(token), `missing source token: ${token}`).toBe(true);
}

describe('L1-B11-B chunk and QA desktop controls', () => {
  it('L1-B11-B-PARSE-003-UI01 accepts the complete FastGPT-equivalent settings surface', () => {
    const parsed = parseChunkingSettingsDraft({
      trainingType: 'chunk',
      chunkSettingMode: 'custom',
      chunkTriggerType: 'minSize',
      chunkTriggerMinSize: 100,
      chunkSplitMode: 'paragraph',
      paragraphChunkAIMode: 'auto',
      paragraphChunkDeep: 5,
      paragraphChunkMinSize: 100,
      chunkSize: 512,
      chunkSplitter: '\\n---\\n',
      indexSize: 512,
      overlap: 100,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(buildImportChunkingSettings(parsed.data)).toMatchObject({
        chunkTriggerType: 'minSize',
        paragraphChunkAIMode: 'auto',
        paragraphChunkDeep: 5,
        overlap: 100,
      });
    }
  });

  it('L1-B11-B-PARSE-003-UI02 rejects incompatible mode values and clears QA-only input', () => {
    expect(
      parseChunkingSettingsDraft({
        trainingType: 'chunk',
        chunkSettingMode: 'auto',
        chunkSplitMode: 'size',
        paragraphChunkAIMode: 'force',
      }).success,
    ).toBe(false);
    expect(
      parseChunkingSettingsDraft({
        trainingType: 'chunk',
        chunkSettingMode: 'auto',
        qaPrompt: 'must not be persisted outside QA mode',
      }).success,
    ).toBe(false);
  });

  it('L1-B11-B-PARSE-003-UI03 exposes trigger, paragraph AI and overlap controls', () => {
    const panel = readFileSync(join(root, 'components', 's5-parse-settings.tsx'), 'utf8');
    for (const token of [
      'chunkTriggerType',
      'paragraphChunkAIMode',
      'paragraphChunkDeep',
      'overlap',
      'indexSize',
    ]) {
      expectSourceContains(panel, token);
    }
  });

  it('L1-B11-B-PARSE-004-UI01 exposes a QA Prompt editor only in QA mode', () => {
    const panel = readFileSync(join(root, 'components', 's5-parse-settings.tsx'), 'utf8');
    expectSourceContains(panel, "settings.trainingType === 'qa'");
    expectSourceContains(panel, 'qaPrompt');
  });

  it('L1-B11-B-PARSE-004-UI02 never exposes implicit raw fallback as success', () => {
    const importWorkspace = readFileSync(join(root, 'product', 'import-workspace.tsx'), 'utf8');
    for (const token of [
      'QA 成功',
      '无效输出最多自动修复一次',
      '任务明确失败',
      'errorReason',
      '原因：',
    ]) {
      expectSourceContains(importWorkspace, token);
    }
    expect(importWorkspace.includes('无效输出使用') && importWorkspace.includes('原文回退')).toBe(
      false,
    );
    const processing = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        'service',
        'src',
        'modules',
        'knowledge',
        'application',
        's06-processing.application.ts',
      ),
      'utf8',
    );
    expectSourceContains(processing, "qaFallbackPolicy: 'none'");
  });
});
