/**
 * @kb/qa 冻结类型（设计文档 9.9.1）。
 */

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
