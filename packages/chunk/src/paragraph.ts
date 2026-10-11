/**
 * @kb/chunk 归一化与分隔候选（设计文档 9.8.1 切分算法第 1、2 步）。
 * 分隔顺序：自定义正则 → Markdown 标题 → 表格边界 → 段落 → 句子递归。
 */
export type SegmentKind = 'text' | 'heading' | 'table' | 'custom';

export interface Segment {
  text: string;
  kind: SegmentKind;
}

export interface SegmentOptions {
  customRegs: readonly string[];
  paragraphDeep: number;
}

/** 归一化换行、去除零宽字符、折叠连续空行。 */
export function normalizeChunkText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u200b|\u200c|\u200d|\u2060|\ufeff/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

const HEADING_RE = /^(#{1,6})\s+/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;

function isHeading(line: string): boolean {
  return HEADING_RE.test(line);
}

function isTableLine(line: string): boolean {
  return TABLE_ROW_RE.test(line);
}

function splitLines(text: string): string[] {
  return text.split('\n');
}

/** 按自定义正则切分；每条正则只保留命中边界，最大 5 条。 */
function splitByCustom(text: string, regs: readonly string[]): string[] {
  if (regs.length === 0) return [text];
  const pattern = new RegExp(`(?:${regs.map((reg) => `(?:${reg})`).join('|')})`);
  return text.split(pattern);
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n{2,}/);
}

function splitSentences(text: string): string[] {
  const matches = text.match(/[^。！？!?.\n]+[。！？!?.]?|\n/g);
  return matches ? matches.map((part) => part.trim()).filter((part) => part.length > 0) : [text];
}

function splitStructural(text: string, depth: number, opts: SegmentOptions): Segment[] {
  const customParts = splitByCustom(text, opts.customRegs);
  if (customParts.length > 1) {
    const segments: Segment[] = [];
    customParts.forEach((part, index) => {
      if (index > 0) segments.push({ text: '', kind: 'custom' });
      segments.push(...splitStructural(part, depth, opts));
    });
    return segments.filter((segment) => segment.text.length > 0 || segment.kind === 'custom');
  }

  const lines = splitLines(text);
  const segments: Segment[] = [];
  let buffer: string[] = [];
  let tableBuffer: string[] = [];
  let mode: 'text' | 'heading' | 'table' = 'text';

  const flush = (): void => {
    if (mode === 'table' && tableBuffer.length > 0) {
      segments.push({ text: tableBuffer.join('\n'), kind: 'table' });
      tableBuffer = [];
    } else if (buffer.length > 0) {
      segments.push({ text: buffer.join('\n'), kind: mode });
      buffer = [];
    }
    mode = 'text';
  };

  for (const line of lines) {
    if (isTableLine(line)) {
      if (mode !== 'table') flush();
      mode = 'table';
      tableBuffer.push(line);
      continue;
    }
    if (isHeading(line)) {
      flush();
      segments.push({ text: line, kind: 'heading' });
      continue;
    }
    if (mode === 'table') flush();
    buffer.push(line);
  }
  flush();

  if (depth >= opts.paragraphDeep) return segments;

  const expanded: Segment[] = [];
  for (const segment of segments) {
    if (segment.kind === 'table' || segment.kind === 'heading') {
      expanded.push(segment);
      continue;
    }
    const paragraphs = splitParagraphs(segment.text);
    if (paragraphs.length <= 1) {
      expanded.push(segment);
      continue;
    }
    for (const paragraph of paragraphs) {
      if (paragraph.trim().length === 0) continue;
      if (depth + 1 < opts.paragraphDeep) {
        const sentences = splitSentences(paragraph);
        if (sentences.length > 1) {
          for (const sentence of sentences) expanded.push({ text: sentence, kind: 'text' });
          continue;
        }
      }
      expanded.push({ text: paragraph, kind: 'text' });
    }
  }
  return expanded;
}

/** 构建分隔候选片段；表格/标题/自定义片段标记为不可重叠。 */
export function buildSegments(text: string, opts: SegmentOptions): Segment[] {
  return splitStructural(text, 1, opts);
}
