import { describe, expect, it } from 'vitest';
import {
  isEmbeddingCandidate,
  isImageLlmCandidate,
  isTextLlmCandidate,
  modelsForRole,
} from '../../src/product/model-candidates';
import type { Model } from '../../src/product/types';

function model(overrides: Partial<Model>): Model {
  return {
    modelId: 'model',
    displayName: 'Model',
    provider: 'Provider',
    type: 'llm',
    capabilities: ['chat'],
    tags: [],
    dimension: null,
    authorized: true,
    ...overrides,
  };
}

describe('knowledge model role candidates', () => {
  it('uses one rule for text, embedding and visual LLM candidates', () => {
    const models = [
      model({ modelId: 'chat', type: 'llm', capabilities: ['chat'] }),
      model({ modelId: 'vision-llm', type: 'llm', capabilities: ['chat', 'vision'] }),
      model({ modelId: 'vlm', type: 'vlm', capabilities: ['vision'] }),
      model({
        modelId: 'embedding',
        type: 'embedding',
        capabilities: ['text-embedding'],
        dimension: 1024,
      }),
      model({
        modelId: 'bad-dimension',
        type: 'embedding',
        capabilities: ['text-embedding'],
        dimension: 999 as 1024,
      }),
      model({
        modelId: 'unauthorized',
        type: 'llm',
        capabilities: ['chat', 'vision'],
        authorized: false,
      }),
    ];
    expect(modelsForRole(models, 'llm').map((item) => item.modelId)).toEqual([
      'chat',
      'vision-llm',
    ]);
    expect(modelsForRole(models, 'vlm').map((item) => item.modelId)).toEqual(['vision-llm', 'vlm']);
    expect(modelsForRole(models, 'embedding').map((item) => item.modelId)).toEqual(['embedding']);
    expect(isTextLlmCandidate(models[0]!)).toBe(true);
    expect(isImageLlmCandidate(models[1]!)).toBe(true);
    expect(isEmbeddingCandidate(models[3]!)).toBe(true);
  });
});
