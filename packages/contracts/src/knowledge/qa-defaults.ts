export const DEFAULT_QA_PROMPT = `<Context></Context> 标记中是一段文本，学习和分析它，并整理学习成果：
- 提出问题并给出每个问题的答案。
- 答案需详细完整，尽可能保留原文描述，可以适当扩展答案描述。
- 答案可以包含普通文字、链接、代码、表格、公示、媒体链接等 Markdown 元素。
- 最多提出 50 个问题。
- 生成的问题和答案和源文本语言相同。
`;

export const QA_FIXED_TEMPLATE = `请按以下格式整理学习成果:
<Context>
文本
</Context>
Q1: 问题。
A1: 答案。
Q2:
A2:

------

我们开始吧!

<Context>
{{text}}
</Context>
`;

export const MAX_QA_PER_CHUNK = 50;
