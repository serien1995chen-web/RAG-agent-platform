import type { Model } from './types';

export type KnowledgeModelRole = 'embedding' | 'llm' | 'vlm';

const VALID_EMBEDDING_DIMENSIONS = new Set([768, 1024, 1536, 3072]);

export function isEmbeddingCandidate(model: Model): boolean {
  return (
    model.authorized &&
    model.type === 'embedding' &&
    model.capabilities.includes('text-embedding') &&
    typeof model.dimension === 'number' &&
    VALID_EMBEDDING_DIMENSIONS.has(model.dimension)
  );
}

export function isTextLlmCandidate(model: Model): boolean {
  return model.authorized && model.type === 'llm' && model.capabilities.includes('chat');
}

export function isImageLlmCandidate(model: Model): boolean {
  return (
    model.authorized &&
    model.capabilities.includes('vision') &&
    (model.type === 'vlm' || model.type === 'llm')
  );
}

export function modelsForRole(models: readonly Model[], role: KnowledgeModelRole): Model[] {
  const predicate =
    role === 'embedding'
      ? isEmbeddingCandidate
      : role === 'llm'
        ? isTextLlmCandidate
        : isImageLlmCandidate;
  return models.filter(predicate);
}

export function isModelEligibleForRole(model: Model, role: KnowledgeModelRole): boolean {
  return modelsForRole([model], role).length === 1;
}
