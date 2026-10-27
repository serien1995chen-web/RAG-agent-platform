/**
 * @kb/qa — QA 生成、Schema 校验、去重与回退（CR-FEATURE-06，设计文档 9.9.1）。
 * 输出解析失败必须回退 chunk_split 并记录指标，不得伪造 QA。
 */
import { createHash } from 'node:crypto';
import { KnowledgeApiError, createKnowledgeError, type KnowledgeErrorCode } from '@kb/contracts';
import { dedupeQaItems } from './dedup';
import { buildQaDedupKey, normalizeQaText } from './dedup';
import { buildQaPrompt, resolvePrompt, type QaTemplateRegistryPort } from './prompt';
import type { QaModelPort, QaRequest, QaResult } from './parser';
import { parseQaOutputValidated } from './s5-validation';

export const PACKAGE_NAME = '@kb/qa' as const;

export const DEFAULT_QA_TIMEOUT_MS = 10 * 60 * 1000;

export type {
  QaLimits,
  QaModelInput,
  QaModelOutput,
  QaModelPort,
  QaRequest,
  QaResult,
  QaResultItem,
} from './parser';
export {
  DEFAULT_QA_PROMPT,
  DEFAULT_QA_PROMPT_HASH,
  DEFAULT_TEMPLATE_ID,
  DEFAULT_TEMPLATE_LOCALE,
  DEFAULT_TEMPLATE_VERSION,
  buildQaPrompt,
  createDefaultTemplateRegistry,
  resolvePrompt,
} from './prompt';
export type { QaTemplate, QaTemplateRegistryPort } from './prompt';
export { parseQaOutput } from './parser';
export { dedupeQaItems, limitChunkCount } from './dedup';
export type { DedupOutcome } from './dedup';

export { buildQaDedupKey, normalizeQaText };
export { parseQaOutputValidated, repairQaOutputOnce, validateQaItems } from './s5-validation';
export type { QaValidationResult } from './s5-validation';

export interface GenerateQaOptions {
  templateRegistry: QaTemplateRegistryPort;
  model: QaModelPort;
  /** 解析失败时回退 chunk 结果（fallback=chunk_split）；缺省仅标记 fallback。 */
  fallbackToChunkSplit?: (
    request: QaRequest,
  ) => Promise<Pick<QaResult, 'items'>> | Pick<QaResult, 'items'>;
  timeoutMs?: number;
}

function qaError(
  code: KnowledgeErrorCode,
  params: Record<string, unknown>,
  requestId: string,
): KnowledgeApiError {
  return createKnowledgeError({
    code,
    requestId,
    traceId: requestId,
    details: params,
  });
}

function modelFailure(error: unknown, request: QaRequest, requestId: string): Error {
  if (error instanceof KnowledgeApiError) return error;
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
  const status = record?.status ?? record?.statusCode ?? record?.httpStatus;
  if (status === 429) {
    return qaError(
      'KNOWLEDGE_RATE_LIMITED',
      { model: request.models.llmModel, taskId: requestId, upstreamStatus: 429 },
      requestId,
    );
  }
  if (record?.name === 'AbortError' || record?.name === 'TimeoutError') {
    return qaError(
      'KNOWLEDGE_DEPENDENCY_TIMEOUT',
      { model: request.models.llmModel, taskId: requestId, reason: 'model_timeout' },
      requestId,
    );
  }
  return qaError(
    'KNOWLEDGE_MODEL_FAILED',
    {
      model: request.models.llmModel,
      taskId: requestId,
      reason: typeof status === 'number' && status >= 500 ? 'model_retryable_error' : 'model_error',
    },
    requestId,
  );
}

/**
 * 编排：模板解析 → 模型调用 → 输出解析 → 去重 → 回退。
 * 模板未注册 → KNOWLEDGE_NOT_FOUND；模型失败 → KNOWLEDGE_MODEL_FAILED；
 * 解析失败/为空 → fallback=chunk_split，不伪造 QA。
 */
export async function generateQa(
  request: QaRequest,
  options: GenerateQaOptions,
): Promise<QaResult> {
  const requestId =
    request.sourceId + ':' + request.qaTemplateId + '@' + String(request.qaTemplateVersion);
  const template = await options.templateRegistry.find(
    request.qaTemplateId,
    request.qaTemplateVersion,
  );
  if (!template || template.status !== 'active') {
    throw qaError('KNOWLEDGE_NOT_FOUND', { templateId: request.qaTemplateId }, requestId);
  }

  const prompt = buildQaPrompt(resolvePrompt(template, request), request.chunkText);
  let output;
  try {
    output = await options.model.generate({
      model: request.models.llmModel,
      prompt,
      chunkText: request.chunkText,
      timeoutMs: options.timeoutMs ?? DEFAULT_QA_TIMEOUT_MS,
    });
  } catch (error) {
    throw modelFailure(error, request, requestId);
  }

  const sourceChunkHash =
    request.sourceChunkHash ??
    `sha256:${createHash('sha256').update(request.chunkText, 'utf8').digest('hex')}`;
  const parsed = parseQaOutputValidated(output.content, sourceChunkHash);
  if (parsed.items.length === 0) {
    const fallbackItems = options.fallbackToChunkSplit
      ? (await options.fallbackToChunkSplit(request)).items
      : [];
    return {
      items: fallbackItems,
      usage: output.usage,
      fallback: 'chunk_split',
      diagnostics: [{ code: 'qa_output_invalid', problems: parsed.problems }],
    };
  }

  const deduped = dedupeQaItems(parsed.items, request.limits.maxQaPerChunk);
  return {
    items: deduped.items,
    usage: output.usage,
    fallback: 'none',
    diagnostics: [
      ...(deduped.duplicates > 0
        ? [{ code: 'qa_duplicate_removed', count: deduped.duplicates }]
        : []),
      ...(deduped.overLimit > 0 ? [{ code: 'qa_over_limit', count: deduped.overLimit }] : []),
    ],
  };
}
