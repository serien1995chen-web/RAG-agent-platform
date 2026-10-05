/**
 * @kb/qa — QA 生成、Schema 校验、去重与回退（CR-FEATURE-06，设计文档 9.9.1）。
 * 输出解析失败必须回退 chunk_split 并记录指标，不得伪造 QA。
 */
import { createHash } from 'node:crypto';
import { ApiErrorException, createSkeletonError } from '@kb/contracts';

export const PACKAGE_NAME = '@kb/qa' as const;

export interface QaLimits {
  maxQaPerChunk: number;
  maxChunkCount: number;
}

export interface QaRequest {
  teamId: string;
  datasetId: string;
  collectionId: string;
  chunkText: string;
  qaTemplateId: string;
  qaTemplateVersion: number;
  qaPrompt?: string;
  models: { llmModel: string; embeddingModel: string; vectorModel: string };
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
}

export function normalizeQaText(text: string): string {
  return text.normalize('NFKC').trim();
}

/** qa:sha256(NFKC(trim(q)) + NUL + NFKC(trim(a)))（设计文档 9.9.1）。 */
export function buildQaDedupKey(q: string, a: string): string {
  const hash = createHash('sha256')
    .update(`${normalizeQaText(q)}\u0000${normalizeQaText(a)}`)
    .digest('hex');
  return `qa:${hash}`;
}

export function generateQa(_request: QaRequest): Promise<QaResult> {
  return Promise.reject(new ApiErrorException(createSkeletonError({ operation: 'qa' }, 'qa')));
}
