/**
 * @kb/qa 输出解析与冻结类型（设计文档 9.9.1）。
 * 优先匹配 Q<i>: … A<i>: … 结构；JSON 片段用 jsonrepair 修复；解析失败或为空返回空 items。
 * 本文件承载 @kb/qa 的共享类型，作为叶子模块供 dedup/prompt/index 复用，避免循环依赖。
 */
import { jsonrepair } from 'jsonrepair';

export interface QaLimits {
  maxQaPerChunk: number;
  maxChunkCount: number;
}

export interface QaRequest {
  workspaceId: string;
  knowledgeSpaceId: string;
  sourceId: string;
  chunkText: string;
  qaTemplateId: string;
  qaTemplateVersion: number;
  qaPrompt?: string;
  sourceChunkHash?: string;
  models: { llmModel: string; embeddingModel: string };
  limits: QaLimits;
}

export interface QaResultItem {
  q: string;
  a: string;
  sourceChunkHash: string;
}

export interface QaResult {
  items: QaResultItem[];
  usage: { inputTokens: number; outputTokens: number };
  fallback: 'none' | 'chunk_split';
  diagnostics: Array<{
    code: string;
    count?: number;
    problems?: string[];
  }>;
}

export interface QaModelInput {
  model: string;
  prompt: string;
  chunkText: string;
  timeoutMs: number;
}

export interface QaModelOutput {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** 模型调用通过 Provider Port 注入，错误按 9.9.1 分类（429/5xx/超时 retryable）。 */
export interface QaModelPort {
  generate(input: QaModelInput): Promise<QaModelOutput>;
}

const QA_PAIR_RE =
  /Q(\d+)\s*[:：]\s*([\s\S]*?)\s*A\1\s*[:：]\s*([\s\S]*?)(?=\s*Q\d+\s*[:：]|\s*$)/g;

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function toItem(q: string, a: string, sourceChunkHash: string): QaResultItem | null {
  const question = clean(q);
  const answer = clean(a);
  if (question.length === 0 || answer.length === 0) return null;
  return { q: question, a: answer, sourceChunkHash };
}

export function parseQaPairs(content: string): Array<{ q: string; a: string }> {
  const pairs: Array<{ q: string; a: string }> = [];
  QA_PAIR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QA_PAIR_RE.exec(content)) !== null) {
    pairs.push({ q: match[2] ?? '', a: match[3] ?? '' });
  }
  return pairs;
}

/** 解析 Q/A 文本结构；保序，重复由 dedup 处理。 */
export function parseQaOutput(content: string, sourceChunkHash: string): QaResultItem[] {
  if (!content || content.trim().length === 0) return [];
  const items = parseQaPairs(content)
    .map((pair) => toItem(pair.q, pair.a, sourceChunkHash))
    .filter((item): item is QaResultItem => item !== null);
  if (items.length > 0) return items;
  return parseJsonOutput(content, sourceChunkHash);
}

interface JsonPair {
  q?: unknown;
  a?: unknown;
  question?: unknown;
  answer?: unknown;
}

function parseJsonOutput(content: string, sourceChunkHash: string): QaResultItem[] {
  const repaired = repairJson(content);
  if (repaired === null) return [];
  const items: QaResultItem[] = [];
  for (const entry of repaired) {
    const q =
      typeof entry.q === 'string'
        ? entry.q
        : typeof entry.question === 'string'
          ? entry.question
          : '';
    const a =
      typeof entry.a === 'string' ? entry.a : typeof entry.answer === 'string' ? entry.answer : '';
    const item = toItem(q, a, sourceChunkHash);
    if (item) items.push(item);
  }
  return items;
}

function repairJson(content: string): JsonPair[] | null {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  const fragment = content.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fragment);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(fragment));
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((entry): entry is JsonPair => typeof entry === 'object' && entry !== null);
}
