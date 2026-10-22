import { describe, expect, it } from 'vitest';
import {
  createDefaultTemplateRegistry,
  generateQa,
  type QaModelPort,
  type QaRequest,
} from '../../src/index';

function request(overrides: Partial<QaRequest> = {}): QaRequest {
  return {
    workspaceId: 'ws-1',
    knowledgeSpaceId: 'space-1',
    sourceId: 'src-1',
    chunkText: '知识库平台的导入链路包含解析、切分与质量校验。',
    qaTemplateId: 'qa.default',
    qaTemplateVersion: 1,
    models: { llmModel: 'gpt-test', embeddingModel: 'emb' },
    limits: { maxQaPerChunk: 5, maxChunkCount: 50000 },
    ...overrides,
  };
}

function modelReturning(content: string): QaModelPort {
  return {
    generate: async () => ({ content, usage: { inputTokens: 10, outputTokens: 20 } }),
  };
}

describe('TEST-QA-FALLBACK-001 QA pipeline', () => {
  it('generates deduped QA items with usage', async () => {
    const content =
      'Q1: 导入链路包含什么？\nA1: 解析、切分与质量校验。\nQ2: 另一问题\nA2: 另一答案';
    const result = await generateQa(request(), {
      templateRegistry: createDefaultTemplateRegistry(),
      model: modelReturning(content),
    });
    expect(result.fallback).toBe('none');
    expect(result.items).toHaveLength(2);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it('keeps only the first duplicate item', async () => {
    const content = 'Q1: 重复问题\nA1: 重复答案\nQ2: 重复问题\nA2: 重复答案';
    const result = await generateQa(request(), {
      templateRegistry: createDefaultTemplateRegistry(),
      model: modelReturning(content),
    });
    expect(result.items).toHaveLength(1);
  });

  it('rejects an unregistered template with KNOWLEDGE_NOT_FOUND', async () => {
    const error = await generateQa(request({ qaTemplateId: 'qa.custom', qaTemplateVersion: 9 }), {
      templateRegistry: createDefaultTemplateRegistry(),
      model: modelReturning('Q1: q\nA1: a'),
    }).catch((thrown: unknown) => thrown);
    expect((error as { problem: { error: { code: string } } }).problem.error.code).toBe(
      'KNOWLEDGE_NOT_FOUND',
    );
  });

  it('marks fallback=chunk_split when the model output is unparseable', async () => {
    const result = await generateQa(request(), {
      templateRegistry: createDefaultTemplateRegistry(),
      model: modelReturning('模型没有按格式返回'),
      fallbackToChunkSplit: () => ({
        items: [{ q: '', a: 'chunk', sourceChunkHash: 'h' }],
      }),
    });
    expect(result.fallback).toBe('chunk_split');
  });

  it('classifies retryable model failures as KNOWLEDGE_MODEL_FAILED', async () => {
    const model: QaModelPort = {
      generate: async () => {
        const error = new Error('rate limited') as Error & { status: number; retryable: string };
        error.status = 429;
        error.retryable = 'retryable';
        throw error;
      },
    };
    const error = await generateQa(request(), {
      templateRegistry: createDefaultTemplateRegistry(),
      model,
    }).catch((thrown: unknown) => thrown);
    expect((error as { problem: { error: { code: string } } }).problem.error.code).toBe(
      'KNOWLEDGE_MODEL_FAILED',
    );
    expect((error as { problem: { error: { retryable: boolean } } }).problem.error.retryable).toBe(
      true,
    );
  });
});
