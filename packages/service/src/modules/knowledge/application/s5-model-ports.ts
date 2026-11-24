import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';

export const S5_MODEL_TYPES = ['llm', 'embedding', 'rerank', 'vlm', 'stt', 'tts'] as const;
export type S5ModelType = (typeof S5_MODEL_TYPES)[number];
export const S5_VECTOR_DIMENSIONS = [768, 1024, 1536, 3072] as const;
export type S5VectorDimension = (typeof S5_VECTOR_DIMENSIONS)[number];

export interface ModelLimits {
  maxToken?: number;
  defaultToken?: number;
  maxContext?: number;
  maxResponse?: number;
}

export interface ModelCatalogItem {
  modelId: string;
  displayName: string;
  provider?: string;
  type: S5ModelType;
  capabilities: string[];
  tags?: string[];
  dimension: S5VectorDimension | null;
  limits?: ModelLimits;
  authorized: boolean;
}

export interface ModelDefaults {
  embedding: string | null;
  textLLM: string | null;
  imageLLM: string | null;
}

export interface ModelCatalogMetadata {
  defaults: ModelDefaults;
  source: 'database' | 'environment' | 'mock';
}

export interface ModelSettingItem {
  modelId: string;
  displayName: string;
  provider: string;
  type: S5ModelType;
  capabilities: string[];
  tags: string[];
  enabled: boolean;
  dimension: S5VectorDimension | null;
  limits?: ModelLimits;
}

export interface ModelSettingsView {
  version: number;
  source: 'database' | 'environment';
  models: ModelSettingItem[];
  defaults: ModelDefaults;
}

export interface ModelCatalogPort {
  listModels(input: {
    workspaceId: string;
    requestId: string;
    traceId: string;
  }): Promise<ModelCatalogItem[]>;
  getMetadata?(input: {
    workspaceId: string;
    requestId: string;
    traceId: string;
  }): Promise<ModelCatalogMetadata>;
  getSettings?(input: {
    workspaceId: string;
    requestId: string;
    traceId: string;
  }): Promise<ModelSettingsView>;
  updateSettings?(
    input: {
      workspaceId: string;
      memberId: string;
      requestId: string;
      traceId: string;
    },
    settings: Omit<ModelSettingsView, 'source'>,
  ): Promise<ModelSettingsView>;
}

export interface ModelValidation {
  valid: true;
  modelId: string;
  modelType: S5ModelType;
  capabilities: string[];
}

export interface ModelBindingInput {
  modelType: S5ModelType;
  modelId: string;
  displayName: string;
  requiredCapabilities: string[];
  status: 'active' | 'disabled';
}

export type ModelBindingView = ModelBindingInput;

export interface ModelBindingRepositoryPort {
  list(spaceId: string, context: TenantContext): Promise<ModelBindingView[]>;
  replace(
    spaceId: string,
    expectedVersion: number,
    bindings: readonly ModelBindingInput[],
    context: TenantContext,
  ): Promise<{ items: ModelBindingView[]; version: number }>;
}

export interface S5ModelAccessPort {
  assertScope(
    scope: 'knowledge:read' | 'knowledge:write' | 'knowledge:manage',
    context: TenantContext,
  ): void;
}

export function assertModelScope(
  context: TenantContext,
  scope: 'knowledge:read' | 'knowledge:write' | 'knowledge:manage',
): void {
  if (context.isWorkspaceOwner || context.scopes.includes(scope)) return;
  throw createKnowledgeError({
    code: 'KNOWLEDGE_FORBIDDEN',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { scope },
  });
}

export function modelCapabilities(model: ModelCatalogItem): string[] {
  const capabilities = [...model.capabilities];
  if (
    model.type === 'embedding' &&
    model.dimension !== null &&
    !capabilities.includes(`dimension:${model.dimension}`)
  ) {
    capabilities.push(`dimension:${model.dimension}`);
  }
  return [...new Set(capabilities)].sort();
}
