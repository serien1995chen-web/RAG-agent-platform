import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { KnowledgeOperationInput, KnowledgeOperationResult } from './knowledge.application';
import {
  modelCapabilities,
  type ModelCatalogItem,
  type ModelCatalogPort,
  type ModelValidation,
  type S5ModelType,
  S5_MODEL_TYPES,
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
    type: item.type,
    capabilities: modelCapabilities(item),
    authorized: item.authorized,
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
  if (model.type !== modelType) {
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

  async dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    if (input.operationId === 'API-MODEL-LIST') return this.listModels(input);
    if (input.operationId === 'API-MODEL-BINDING-VALIDATE') {
      return this.validateBinding(input);
    }
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
