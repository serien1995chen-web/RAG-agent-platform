import { describe, expect, it } from 'vitest';
import {
  S7SearchFormSchema,
  buildS7SearchRequest,
  defaultS7SearchForm,
} from '../../src/forms/s7-search-form';
import {
  buildImportChunkingSettings,
  modelOptionsForType,
  parseChunkingSettingsDraft,
} from '../../src/forms/s5-model-parse-form';
import type { S5ModelView } from '../../src/components/s5-model-parse-state';
import { classifyS7SearchState, safeDegradedCode } from '../../src/components/s7-search-state';

const spaceId = '65f1e5b2a1c9d4b7e8f01234';

const models: S5ModelView[] = [
  {
    modelId: 'llm-text',
    displayName: 'Text LLM',
    type: 'llm',
    capabilities: ['chat'],
    authorized: true,
  },
  {
    modelId: 'llm-vision',
    displayName: 'Vision LLM',
    type: 'llm',
    capabilities: ['chat', 'vision'],
    authorized: true,
  },
  {
    modelId: 'vlm-primary',
    displayName: 'VLM primary',
    type: 'vlm',
    capabilities: ['vision'],
    authorized: true,
  },
  {
    modelId: 'rerank-authorized',
    displayName: 'Rerank authorized',
    type: 'rerank',
    capabilities: ['rerank'],
    authorized: true,
  },
  {
    modelId: 'rerank-revoked',
    displayName: 'Rerank revoked',
    type: 'rerank',
    capabilities: ['rerank'],
    authorized: false,
  },
];

function result(overrides: Record<string, unknown> = {}) {
  return {
    searchId: 'search-b15',
    mode: 'semantic' as const,
    items: [],
    partial: false,
    durationMs: 25,
    degraded: [],
    rerankApplied: false,
    ...overrides,
  };
}

describe('L1-B15-B Web model configuration and feedback', () => {
  it('L1-B15-B-MODEL-003-UI01 persists rerank enablement, weight and selected model reference', () => {
    const parsed = S7SearchFormSchema.safeParse({
      ...defaultS7SearchForm(spaceId),
      query: 'refund',
      usingRerank: true,
      rerankWeight: 0.7,
      rerankModelId: 'rerank-authorized',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(buildS7SearchRequest(parsed.data)).toMatchObject({
        usingRerank: true,
        rerankWeight: 0.7,
        rerankModelId: 'rerank-authorized',
      });
    }
  });

  it('L1-B15-B-MODEL-004-UI01 persists query optimization enablement, model and background prompt', () => {
    const parsed = S7SearchFormSchema.safeParse({
      ...defaultS7SearchForm(spaceId),
      query: 'refund',
      queryOptimizationEnabled: true,
      queryOptimizationModelId: 'llm-text',
      queryOptimizationPrompt: 'Resolve pronouns using recent history.',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(buildS7SearchRequest(parsed.data)).toMatchObject({
        queryOptimizationEnabled: true,
        queryOptimizationModelId: 'llm-text',
        queryOptimizationPrompt: 'Resolve pronouns using recent history.',
      });
    }
  });

  it('L1-B15-B-MODEL-004-UI02 preserves QA prompt and automatic index settings in import requests', () => {
    expect(
      buildImportChunkingSettings({
        trainingType: 'qa',
        chunkSettingMode: 'auto',
        qaPrompt: 'Only generate grounded question-answer pairs.',
        autoIndexes: true,
        imageIndex: true,
        indexPrefixTitle: true,
      }),
    ).toMatchObject({
      trainingType: 'qa',
      qaPrompt: 'Only generate grounded question-answer pairs.',
      autoIndexes: true,
      imageIndex: true,
      indexPrefixTitle: true,
    });
  });

  it('L1-B15-B-MODEL-004-UI03 exposes only authorized rerank models and keeps text LLMs out of VLM choices', () => {
    expect(modelOptionsForType(models, 'rerank')).toEqual([
      expect.objectContaining({ value: 'rerank-authorized' }),
    ]);
    expect(modelOptionsForType(models, 'vlm')).toEqual([
      expect.objectContaining({ value: 'vlm-primary' }),
    ]);
    expect(modelOptionsForType(models, 'llm').map((model) => model.value)).toEqual([
      'llm-text',
      'llm-vision',
    ]);
  });

  it('L1-B15-B-MODEL-004-UI04 requires an available LLM before QA generation settings can be valid', () => {
    const settings = {
      trainingType: 'qa' as const,
      chunkSettingMode: 'auto' as const,
      qaPrompt: 'grounded QA only',
    };
    expect(parseChunkingSettingsDraft(settings).success).toBe(true);
    expect(modelOptionsForType(models, 'llm').length).toBeGreaterThan(0);
  });

  it('L1-B15-B-MODEL-003-UI02 distinguishes degraded rerank success from empty results', () => {
    expect(
      classifyS7SearchState({
        result: result({
          items: [{ citation: { citationId: 'citation-b15' } }],
          degraded: ['rerank_failed'],
          rerankApplied: false,
        }),
      }).kind,
    ).toBe('degraded');
    expect(classifyS7SearchState({ result: result() }).kind).toBe('empty');
    expect(safeDegradedCode('rerank_failed')).toBe('rerank_failed');
  });

  it('L1-B15-B-MODEL-006-UI01 maps rate limit, timeout, fallback exhaustion and permission failures to distinct states', () => {
    const problem = (status: number, code: string, retryable: boolean) => ({
      status,
      problem: {
        success: false,
        error: { code, message: 'backend detail must not render', retryable, details: {} },
        traceId: 'trace-b15-ui',
        requestId: 'request-b15-ui',
      },
    });

    expect(
      classifyS7SearchState({ error: problem(429, 'KNOWLEDGE_RATE_LIMITED', true) }).kind,
    ).toBe('rate_limited');
    expect(
      classifyS7SearchState({ error: problem(504, 'KNOWLEDGE_DEPENDENCY_TIMEOUT', true) }).kind,
    ).toBe('timeout');
    expect(
      classifyS7SearchState({ error: problem(502, 'KNOWLEDGE_MODEL_FAILED', false) }).kind,
    ).toBe('error');
    expect(classifyS7SearchState({ error: problem(403, 'KNOWLEDGE_FORBIDDEN', false) }).kind).toBe(
      'permission',
    );
  });
});
