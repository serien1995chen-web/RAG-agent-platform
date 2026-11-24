import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { KnowledgeOperationInput, KnowledgeOperationResult } from './knowledge.application';
import {
  modelCapabilities,
  type ModelCatalogItem,
  type ModelCatalogPort,
  type ModelDefaults,
  type ModelSettingItem,
  type ModelValidation,
  type S5ModelType,
  S5_MODEL_TYPES,
  S5_VECTOR_DIMENSIONS,
} from './s5-model-ports';
import {
  assertPageCursorExists,
  paginateByKey,
  parseModelSort,
  parsePageCursor,
  parsePageLimit,
} from './s5-pagination';

function operationError(
  code: 'KNOWLEDGE_VALIDATION_FAILED' | 'KNOWLEDGE_MODEL_FAILED',
  context: TenantContext,
  details: Record<string, unknown>,
) {
  return createKnowledgeError({
    code,
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

function adminOnly(context: TenantContext) {
  if (context.isWorkspaceOwner || context.scopes.includes('knowledge:admin')) return;
  throw createKnowledgeError({
    code: 'KNOWLEDGE_FORBIDDEN',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { scope: 'knowledge:admin' },
  });
}

function requireScope(context: TenantContext, scope: 'knowledge:read' | 'knowledge:write'): void {
  if (context.isWorkspaceOwner || context.scopes.includes(scope)) return;
  throw createKnowledgeError({
    code: 'KNOWLEDGE_FORBIDDEN',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { scope },
  });
}

function objectBody(value: unknown, context: TenantContext): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw operationError('KNOWLEDGE_VALIDATION_FAILED', context, {
      field: 'body',
      reason: 'object_required',
    });
  }
  return value as Record<string, unknown>;
}

function modelView(item: ModelCatalogItem) {
  return {
    modelId: item.modelId,
    displayName: item.displayName,
    provider: item.provider ?? 'Other',
    type: item.type,
    capabilities: modelCapabilities(item),
    tags: item.tags ?? [],
    dimension: item.dimension,
    ...(item.limits ? { limits: item.limits } : {}),
    authorized: item.authorized,
  };
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null;
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))].sort();
}

function parseDefaults(value: unknown, context: TenantContext): ModelDefaults {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw operationError('KNOWLEDGE_VALIDATION_FAILED', context, {
      field: 'defaults',
      reason: 'object_required',
    });
  }
  const defaults = value as Record<string, unknown>;
  const read = (key: keyof ModelDefaults) => {
    const item = defaults[key];
    if (item === undefined || item === null || item === '') return null;
    if (typeof item !== 'string') {
      throw operationError('KNOWLEDGE_VALIDATION_FAILED', context, {
        field: `defaults.${key}`,
        reason: 'string_required',
      });
    }
    return item.trim();
  };
  return {
    embedding: read('embedding'),
    textLLM: read('textLLM'),
    imageLLM: read('imageLLM'),
  };
}

function parseSettingModel(
  value: unknown,
  context: TenantContext,
  index: number,
): ModelSettingItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw operationError('KNOWLEDGE_VALIDATION_FAILED', context, {
      field: `models.${index}`,
      reason: 'object_required',
    });
  }
  const item = value as Record<string, unknown>;
  const capabilities = stringList(item.capabilities);
  const tags = stringList(item.tags ?? []);
  const type = item.type;
  const dimension =
    item.dimension === null || item.dimension === undefined ? null : Number(item.dimension);
  if (
    typeof item.modelId !== 'string' ||
    !item.modelId.trim() ||
    typeof item.displayName !== 'string' ||
    !item.displayName.trim() ||
    typeof item.provider !== 'string' ||
    !item.provider.trim() ||
    typeof type !== 'string' ||
    !(S5_MODEL_TYPES as readonly string[]).includes(type) ||
    !capabilities ||
    !tags ||
    (dimension !== null && !(S5_VECTOR_DIMENSIONS as readonly number[]).includes(dimension)) ||
    (type === 'embedding' && dimension === null)
  ) {
    throw operationError('KNOWLEDGE_VALIDATION_FAILED', context, {
      field: `models.${index}`,
    });
  }
  return {
    modelId: item.modelId.trim(),
    displayName: item.displayName.trim(),
    provider: item.provider.trim(),
    type: type as S5ModelType,
    capabilities,
    tags,
    enabled: item.enabled !== false,
    dimension: dimension as 768 | 1024 | 1536 | 3072 | null,
  };
}

function validateModel(
  models: readonly ModelCatalogItem[],
  body: Record<string, unknown>,
  context: TenantContext,
): ModelValidation {
  const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
  const modelType = body.modelType;
  const requiredCapabilities = Array.isArray(body.requiredCapabilities)
    ? [...new Set(body.requiredCapabilities.map(String))]
    : [];
  if (
    modelId.length === 0 ||
    typeof modelType !== 'string' ||
    !(S5_MODEL_TYPES as readonly string[]).includes(modelType) ||
    requiredCapabilities.length !==
      (Array.isArray(body.requiredCapabilities) ? body.requiredCapabilities.length : 0)
  ) {
    throw operationError('KNOWLEDGE_VALIDATION_FAILED', context, {
      field: 'binding',
      reason: 'model_id_type_and_required_capabilities_required',
    });
  }
  const model = models.find((item) => item.modelId === modelId && item.authorized);
  if (!model) {
    throw operationError('KNOWLEDGE_VALIDATION_FAILED', context, {
      field: 'modelId',
      reason: 'not_in_authorized_catalog',
    });
  }
  const compatibleType =
    model.type === modelType ||
    (modelType === 'vlm' && model.type === 'llm' && model.capabilities.includes('vision'));
  if (!compatibleType) {
    throw operationError('KNOWLEDGE_VALIDATION_FAILED', context, {
      field: 'modelType',
      expected: model.type,
    });
  }
  const capabilities = modelCapabilities(model);
  const missing = requiredCapabilities.filter((capability) => !capabilities.includes(capability));
  if (missing.length > 0) {
    throw operationError('KNOWLEDGE_VALIDATION_FAILED', context, {
      field: 'requiredCapabilities',
      missing,
    });
  }
  return {
    valid: true,
    modelId,
    modelType: modelType as S5ModelType,
    capabilities,
  };
}

export class S5ModelApplication {
  constructor(private readonly catalog: ModelCatalogPort) {}

  async listModels(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    requireScope(input.context, 'knowledge:read');
    const models = await this.catalog.listModels({
      workspaceId: input.context.workspaceId,
      requestId: input.context.requestId,
      traceId: input.context.traceId,
    });
    const metadata = this.catalog.getMetadata
      ? await this.catalog.getMetadata({
          workspaceId: input.context.workspaceId,
          requestId: input.context.requestId,
          traceId: input.context.traceId,
        })
      : {
          defaults: { embedding: null, textLLM: null, imageLLM: null },
          source: 'mock' as const,
        };
    const limit = parsePageLimit(input.query, input.context);
    const sort = parseModelSort(input.query, input.context);
    const cursor = parsePageCursor(input.query, sort, input.context);
    const authorizedModels = models
      .filter((item) => item.authorized)
      .map((item) => ({
        ...item,
        modelType: item.type,
      }));
    assertPageCursorExists(cursor, authorizedModels, input.context);
    const page = paginateByKey(authorizedModels, sort, cursor, limit);
    return {
      status: 200,
      data: {
        items: page.items.map(({ modelType: _modelType, ...item }) => modelView(item)),
        pageInfo: page.pageInfo,
        defaults: metadata.defaults,
        source: metadata.source,
      },
    };
  }

  async validateBinding(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    requireScope(input.context, 'knowledge:write');
    const body = objectBody(input.body, input.context);
    const models = await this.catalog.listModels({
      workspaceId: input.context.workspaceId,
      requestId: input.context.requestId,
      traceId: input.context.traceId,
    });
    return { status: 200, data: validateModel(models, body, input.context) };
  }

  async getSettings(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    adminOnly(input.context);
    if (!this.catalog.getSettings) {
      throw operationError('KNOWLEDGE_VALIDATION_FAILED', input.context, {
        field: 'modelSettings',
        reason: 'settings_unavailable',
      });
    }
    return {
      status: 200,
      data: await this.catalog.getSettings({
        workspaceId: input.context.workspaceId,
        requestId: input.context.requestId,
        traceId: input.context.traceId,
      }),
    };
  }

  async updateSettings(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    adminOnly(input.context);
    if (!this.catalog.updateSettings) {
      throw operationError('KNOWLEDGE_VALIDATION_FAILED', input.context, {
        field: 'modelSettings',
        reason: 'settings_unavailable',
      });
    }
    const body = objectBody(input.body, input.context);
    const version = Number(body.version);
    if (!Number.isInteger(version) || version < 0 || !Array.isArray(body.models)) {
      throw operationError('KNOWLEDGE_VALIDATION_FAILED', input.context, {
        field: 'modelSettings',
        reason: 'version_and_models_required',
      });
    }
    const models = body.models.map((value, index) =>
      parseSettingModel(value, input.context, index),
    );
    const defaults = parseDefaults(body.defaults, input.context);
    const updated = await this.catalog.updateSettings(
      {
        workspaceId: input.context.workspaceId,
        memberId: input.context.memberId,
        requestId: input.context.requestId,
        traceId: input.context.traceId,
      },
      { version, models, defaults },
    );
    return { status: 200, data: updated };
  }

  async dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    if (input.operationId === 'API-MODEL-LIST') return this.listModels(input);
    if (input.operationId === 'API-MODEL-BINDING-VALIDATE') {
      return this.validateBinding(input);
    }
    if (input.operationId === 'API-MODEL-SETTINGS-GET') return this.getSettings(input);
    if (input.operationId === 'API-MODEL-SETTINGS-UPDATE') return this.updateSettings(input);
    throw createKnowledgeError({
      code: 'KNOWLEDGE_INTERNAL_ERROR',
      requestId: input.context.requestId,
      traceId: input.context.traceId,
      details: { operationId: input.operationId, application: 's5-model' },
    });
  }
}

export function validateModelBinding(
  models: readonly ModelCatalogItem[],
  body: Record<string, unknown>,
  context: TenantContext,
): ModelValidation {
  return validateModel(models, body, context);
}
