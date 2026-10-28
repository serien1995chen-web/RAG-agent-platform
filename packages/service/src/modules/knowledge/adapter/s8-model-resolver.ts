import { createKnowledgeError } from '@kb/contracts';
import { Types, type Connection } from 'mongoose';
import type { ModelCatalogItem, ModelCatalogPort } from '../application/s5-model-ports';
import type { S8ImageModelResolverPort, S8ImageModels } from '../application/s8-image-deep.ports';
import type { KnowledgeModelBindingDoc } from '../../../shared/persistence/schemas/knowledge-governance.schemas';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { requireWorkspaceId } from '../../../shared/persistence/knowledge/tenant';

const VISION_DIMENSIONS = new Set([768, 1024, 1536, 3072]);

function missingBinding(context: TenantContext, field: string, reason: string) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_VALIDATION_FAILED',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { field, reason },
  });
}

export class S8ModelResolver implements S8ImageModelResolverPort {
  constructor(
    private readonly connection: Connection,
    private readonly catalog: ModelCatalogPort,
  ) {}

  async resolveVlm(spaceId: string, context: TenantContext): Promise<ModelCatalogItem> {
    const models = registerKnowledgeModels(this.connection);
    const binding = await models.KnowledgeModelBinding.findOne({
      workspaceId: requireWorkspaceId(context),
      knowledgeSpaceId: new Types.ObjectId(spaceId),
      modelType: 'vlm',
      status: 'active',
      deletedAt: null,
    }).lean<KnowledgeModelBindingDoc>();
    const catalog = await this.catalog.listModels({
      workspaceId: context.workspaceId,
      requestId: context.requestId,
      traceId: context.traceId,
    });
    const vlm = binding
      ? catalog.find(
          (item): item is ModelCatalogItem =>
            item.modelId === binding.modelId &&
            item.type === 'vlm' &&
            item.authorized &&
            item.capabilities.includes('vision'),
        )
      : undefined;
    if (!vlm) {
      throw missingBinding(context, 'modelBindings.vlm', 'active_vision_binding_required');
    }
    return vlm;
  }

  async resolveVisionEmbedding(
    spaceId: string,
    context: TenantContext,
  ): Promise<S8ImageModels['visionEmbedding']> {
    const models = registerKnowledgeModels(this.connection);
    const binding = await models.KnowledgeModelBinding.findOne({
      workspaceId: requireWorkspaceId(context),
      knowledgeSpaceId: new Types.ObjectId(spaceId),
      modelType: 'embedding',
      status: 'active',
      deletedAt: null,
    }).lean<KnowledgeModelBindingDoc>();
    const catalog = await this.catalog.listModels({
      workspaceId: context.workspaceId,
      requestId: context.requestId,
      traceId: context.traceId,
    });
    const embedding = binding
      ? catalog.find(
          (item): item is ModelCatalogItem =>
            item.modelId === binding.modelId &&
            item.type === 'embedding' &&
            item.authorized &&
            item.capabilities.includes('vision') &&
            item.dimension !== null &&
            VISION_DIMENSIONS.has(item.dimension),
        )
      : undefined;
    if (!embedding || embedding.dimension === null) {
      throw missingBinding(
        context,
        'modelBindings.visionEmbedding',
        'active_vision_embedding_binding_required',
      );
    }
    return {
      ...embedding,
      dimension: embedding.dimension as 768 | 1024 | 1536 | 3072,
    };
  }

  async resolveLlm(spaceId: string, context: TenantContext): Promise<ModelCatalogItem> {
    const models = registerKnowledgeModels(this.connection);
    const binding = await models.KnowledgeModelBinding.findOne({
      workspaceId: requireWorkspaceId(context),
      knowledgeSpaceId: new Types.ObjectId(spaceId),
      modelType: 'llm',
      status: 'active',
      deletedAt: null,
    }).lean<KnowledgeModelBindingDoc>();
    const catalog = await this.catalog.listModels({
      workspaceId: context.workspaceId,
      requestId: context.requestId,
      traceId: context.traceId,
    });
    const llm = binding
      ? catalog.find(
          (item): item is ModelCatalogItem =>
            item.modelId === binding.modelId && item.type === 'llm' && item.authorized,
        )
      : undefined;
    if (!llm) {
      throw missingBinding(context, 'modelBindings.llm', 'active_llm_binding_required');
    }
    return llm;
  }
}
