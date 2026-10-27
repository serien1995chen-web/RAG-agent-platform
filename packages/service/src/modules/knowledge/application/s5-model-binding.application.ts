import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { AccessPort } from './ports';
import type { KnowledgeOperationInput, KnowledgeOperationResult } from './knowledge.application';
import { validateModelBinding } from './s5-model.application';
import type {
  ModelBindingInput,
  ModelBindingRepositoryPort,
  ModelCatalogPort,
  S5ModelType,
} from './s5-model-ports';
import { S5_MODEL_TYPES } from './s5-model-ports';
import { paginateByKey, parseModelSort, parsePageCursor, parsePageLimit } from './s5-pagination';

function objectBody(value: unknown, context: TenantContext): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'body', reason: 'object_required' },
    });
  }
  return value as Record<string, unknown>;
}

function parseBinding(value: unknown, context: TenantContext, index: number): ModelBindingInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: `bindings.${index}` },
    });
  }
  const item = value as Record<string, unknown>;
  const modelType = item.modelType;
  const status = item.status;
  if (
    typeof modelType !== 'string' ||
    !(S5_MODEL_TYPES as readonly string[]).includes(modelType) ||
    typeof item.modelId !== 'string' ||
    item.modelId.trim().length === 0 ||
    typeof item.displayName !== 'string' ||
    item.displayName.trim().length === 0 ||
    !Array.isArray(item.requiredCapabilities) ||
    !item.requiredCapabilities.every((entry) => typeof entry === 'string') ||
    (status !== 'active' && status !== 'disabled')
  ) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: `bindings.${index}` },
    });
  }
  return {
    modelType: modelType as S5ModelType,
    modelId: item.modelId.trim(),
    displayName: item.displayName.trim(),
    requiredCapabilities: item.requiredCapabilities.map((entry) => entry.trim()).sort(),
    status,
  };
}

function parseUpdate(
  body: Record<string, unknown>,
  context: TenantContext,
): { bindings: ModelBindingInput[]; version: number } {
  const version = body.version;
  if (!Number.isInteger(version) || (version as number) < 1) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'version', min: 1 },
    });
  }
  if (!Array.isArray(body.bindings) || body.bindings.length > 6) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'bindings', max: 6 },
    });
  }
  const bindings = body.bindings.map((value, index) => parseBinding(value, context, index));
  const types = new Set(bindings.map((binding) => binding.modelType));
  const ids = new Set(bindings.map((binding) => binding.modelId));
  if (types.size !== bindings.length || ids.size !== bindings.length) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { field: 'bindings', reason: 'model_type_and_id_must_be_unique' },
    });
  }
  return { bindings, version: version as number };
}

export class S5ModelBindingApplication {
  constructor(
    private readonly repository: ModelBindingRepositoryPort,
    private readonly catalog: ModelCatalogPort,
    private readonly access: AccessPort,
  ) {}

  async get(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    const spaceId = input.params.spaceId ?? '';
    const limit = parsePageLimit(input.query, input.context);
    const sort = parseModelSort(input.query, input.context);
    const cursor = parsePageCursor(input.query, sort, input.context);
    await this.access.assertPermission('space', spaceId, 'read', input.context);
    const items = await this.repository.list(spaceId, input.context);
    const page = paginateByKey(items, sort, cursor, limit);
    return {
      status: 200,
      data: {
        items: page.items,
        pageInfo: page.pageInfo,
      },
    };
  }

  async update(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    const spaceId = input.params.spaceId ?? '';
    await this.access.assertPermission('space', spaceId, 'manage', input.context);
    const body = objectBody(input.body, input.context);
    const parsed = parseUpdate(body, input.context);
    const models = await this.catalog.listModels({
      workspaceId: input.context.workspaceId,
      requestId: input.context.requestId,
      traceId: input.context.traceId,
    });
    for (const binding of parsed.bindings) {
      validateModelBinding(
        models,
        {
          modelId: binding.modelId,
          modelType: binding.modelType,
          requiredCapabilities: binding.requiredCapabilities,
        },
        input.context,
      );
    }
    const updated = await this.repository.replace(
      spaceId,
      parsed.version,
      parsed.bindings,
      input.context,
    );
    return {
      status: 200,
      data: {
        ...updated,
        pageInfo: { nextCursor: null, hasMore: false },
      },
    };
  }

  async dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    if (input.operationId === 'API-MODEL-BINDING-GET') return this.get(input);
    if (input.operationId === 'API-MODEL-BINDING-UPDATE') return this.update(input);
    throw createKnowledgeError({
      code: 'KNOWLEDGE_INTERNAL_ERROR',
      requestId: input.context.requestId,
      traceId: input.context.traceId,
      details: { operationId: input.operationId, application: 's5-model-binding' },
    });
  }
}
