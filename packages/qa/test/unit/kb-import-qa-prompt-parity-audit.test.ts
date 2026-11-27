import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QA_PROMPT,
  MAX_QA_PER_CHUNK,
  QA_FIXED_TEMPLATE,
  buildQaPrompt,
} from '../../src/index';

const FASTGPT_QA_GUIDANCE = `<Context></Context> 标记中是一段文本，学习和分析它，并整理学习成果：
- 提出问题并给出每个问题的答案。
- 答案需详细完整，尽可能保留原文描述，可以适当扩展答案描述。
- 答案可以包含普通文字、链接、代码、表格、公示、媒体链接等 Markdown 元素。
- 最多提出 50 个问题。
- 生成的问题和答案和源文本语言相同。`;

describe('KB import QA prompt parity audit', () => {
  it('uses the FastGPT QA guidance as the default editable prompt', () => {
    expect(DEFAULT_QA_PROMPT.trim()).toBe(FASTGPT_QA_GUIDANCE);
    expect(MAX_QA_PER_CHUNK).toBe(50);
  });

  it('keeps the immutable context envelope and Q/A response contract', () => {
    const prompt = buildQaPrompt(DEFAULT_QA_PROMPT, '源文本');
    expect(prompt).toContain('<Context>');
    expect(prompt).toContain('</Context>');
    expect(prompt).toContain('Q1:');
    expect(prompt).toContain('A1:');
    expect(prompt).toContain('源文本');
    expect(prompt).toContain(QA_FIXED_TEMPLATE.replaceAll('{{text}}', '源文本'));
    expect(prompt).not.toContain('----- 文本开始 -----');
  });
});
