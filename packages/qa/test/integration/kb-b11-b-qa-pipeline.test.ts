import { describe, expect, it } from 'vitest';
import {
  createDefaultTemplateRegistry,
  generateQa,
  type QaModelInput,
  type QaModelPort,
  type QaRequest,
} from '../../src/index';

function request(overrides: Partial<QaRequest> = {}): QaRequest {
  return {
    workspaceId: 'ws-b11-b',
    knowledgeSpaceId: 'space-b11-b',
    sourceId: 'source-b11-b',
    chunkText:
      '退款申请会在五个工作日内处理。Refund requests are processed within five business days.',
    sourceChunkHash: 'sha256:chunk-b11-b',
    qaTemplateId: 'qa.default',
    qaTemplateVersion: 1,
    models: { llmModel: 'fake-llm', embeddingModel: 'fake-embedding' },
    limits: { maxQaPerChunk: 5, maxChunkCount: 50_000 },
    ...overrides,
  };
}

class RecordingModel implements QaModelPort {
  readonly inputs: QaModelInput[] = [];

  constructor(private readonly responses: string[]) {}

  async generate(input: QaModelInput) {
    this.inputs.push(input);
    return {
      content: this.responses[Math.min(this.inputs.length - 1, this.responses.length - 1)] ?? '',
      usage: { inputTokens: 11, outputTokens: 7 },
    };
  }
}

describe('L1-B11-B-PARSE-004 generation and fallback', () => {
  it('L1-B11-B-PARSE-004-P01 generates valid pairs with usage and prompt version evidence', async () => {
    const model = new RecordingModel([
      'Q1: 退款需要多久？\nA1: 五个工作日。\nQ2: 超期如何处理？\nA2: 人工审核。',
    ]);
    const result = await generateQa(request(), {
      templateRegistry: createDefaultTemplateRegistry(),
      model,
    });
    expect(result).toMatchObject({
      fallback: 'none',
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    expect(result.items).toHaveLength(2);
    expect(model.inputs).toHaveLength(1);
  });

  it('L1-B11-B-PARSE-004-F01 makes exactly one model request before raw-text fallback', async () => {
    const model = new RecordingModel(['not a valid QA payload', 'still invalid']);
    const result = await generateQa(request(), {
      templateRegistry: createDefaultTemplateRegistry(),
      model,
      fallbackToChunkSplit: () => ({
        items: [
          {
            q: request().chunkText,
            a: '',
            sourceChunkHash: 'sha256:chunk-b11-b',
          },
        ],
      }),
    });
    expect(model.inputs).toHaveLength(1);
    expect(result).toMatchObject({
      fallback: 'chunk_split',
      usage: { inputTokens: 11, outputTokens: 7 },
      items: [{ q: request().chunkText, a: '', sourceChunkHash: 'sha256:chunk-b11-b' }],
    });
  });

  it('L1-B11-B-PARSE-004-P04 passes a custom QA prompt through the active template', async () => {
    const model = new RecordingModel(['Q1: q\nA1: a']);
    await generateQa(request({ qaPrompt: 'B11-B custom grounded QA instruction' }), {
      templateRegistry: createDefaultTemplateRegistry(),
      model,
    });
    expect(model.inputs[0]?.prompt).toContain('B11-B custom grounded QA instruction');
  });

  it('L1-B11-B-PARSE-004-F02 rejects mixed invalid output instead of issuing a model repair retry', async () => {
    const model = new RecordingModel([
      'Q1: valid question\nA1: valid answer\nQ2: truncated tail',
      '[{"q":"replacement","a":"answer"}]',
    ]);
    const result = await generateQa(request(), {
      templateRegistry: createDefaultTemplateRegistry(),
      model,
    });
    expect(model.inputs).toHaveLength(1);
    expect(result.items).toEqual([
      { q: 'valid question', a: 'valid answer', sourceChunkHash: 'sha256:chunk-b11-b' },
    ]);
  });
});
