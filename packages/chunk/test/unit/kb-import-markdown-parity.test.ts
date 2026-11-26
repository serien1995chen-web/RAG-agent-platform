import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkText, toChunkPolicy } from '../../src/index';

const fixture = readFileSync(
  resolve(import.meta.dirname, '../../../../test/fixtures/kb-import-heading-scroll-matrix.md'),
  'utf8',
);

describe('FastGPT Markdown import chunk parity', () => {
  it('preserves heading boundaries and repeats the heading path', () => {
    const result = chunkText({
      text: fixture,
      policy: toChunkPolicy({
        trainingType: 'chunk',
        chunkSettingMode: 'auto',
        chunkSplitMode: 'paragraph',
        autoIndexes: false,
        imageIndex: false,
        indexPrefixTitle: false,
        paragraphChunkAIMode: 'forbid',
        paragraphChunkDeep: 5,
        paragraphChunkMinSize: 100,
      }),
    });

    expect(result.chunks).toHaveLength(4);
    expect(result.chunks[0]?.text).toContain('## 二级标题：预览滚动');
    expect(result.chunks[0]?.text).not.toContain('### 三级标题：Markdown 层级');
    expect(result.chunks[1]?.text).toContain('### 三级标题：Markdown 层级');
    expect(result.chunks[1]?.text).toContain('| 检查项');
    expect(result.chunks[1]?.text).toContain('字号更大且加粗');
    expect(result.chunks[2]?.text).toContain('```text');
    expect(result.chunks[2]?.text).toContain('confirmation must expose per-source status');
    expect(result.chunks[3]?.text).toContain('第 9 段');
    expect(result.chunks[3]?.text).toContain('FASTGPT_IMPORT_PARITY_AUDIT_END');
    expect(
      result.chunks.every((chunk) => chunk.text.startsWith('# FastGPT 导入验收一级标题')),
    ).toBe(true);
  });
});
