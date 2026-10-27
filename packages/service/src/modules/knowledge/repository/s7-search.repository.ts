import { createKnowledgeError } from '@kb/contracts';
import type { Connection } from 'mongoose';
import type {
  ModelCatalogItem,
  ModelCatalogPort,
  S5ModelType,
} from '../application/s5-model-ports';
import type { S7ResolvedModels } from '../application/s7-search.ports';
import type { KnowledgeModelBindingDoc } from '../../../shared/persistence/schemas/knowledge-governance.schemas';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
} from '../../../shared/persistence/knowledge/tenant';

function modelOfType(
  catalog: readonly ModelCatalogItem[],
  modelId: string,
  type: S5ModelType,
): ModelCatalogItem | undefined {
  return catalog.find(
    (model) =>
      model.modelId === modelId &&
      model.type === type &&
      model.authorized &&
      (type !== 'embedding' || model.dimension !== null),
  );
}

export class S7SearchRepository {
  constructor(
    private readonly connection: Connection,
    private readonly catalog: ModelCatalogPort,
  ) {}

  async resolveModels(
    spaceId: string,
    usingRerank: boolean,
    context: TenantContext,
  ): Promise<S7ResolvedModels> {
    try {
      return await this.resolveModelsUnsafe(spaceId, usingRerank, context);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'problem' in error) throw error;
      throw createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { dependency: 'mongo', operation: 'search_model_bindings' },
      });
    }
  }

  private async resolveModelsUnsafe(
    spaceId: string,
    usingRerank: boolean,
    context: TenantContext,
  ): Promise<S7ResolvedModels> {
    const workspaceId = requireWorkspaceId(context);
    const models = registerKnowledgeModels(this.connection);
    const bindings = (await models.KnowledgeModelBinding.find({
      workspaceId,
      knowledgeSpaceId: objectIdOf(spaceId, context, 'spaceId'),
      status: 'active',
      deletedAt: null,
    }).lean()) as unknown as KnowledgeModelBindingDoc[];
    const catalog = await this.catalog.listModels({
      workspaceId,
      requestId: context.requestId,
      traceId: context.traceId,
    });
    const embeddingBinding = bindings.find((binding) => binding.modelType === 'embedding');
    const embedding = embeddingBinding
      ? modelOfType(catalog, embeddingBinding.modelId, 'embedding')
      : undefined;
    if (!embedding || embedding.dimension === null) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'modelBindings.embedding',
        reason: 'active_binding_required',
      });
    }
    const rerankBinding = usingRerank
      ? bindings.find((binding) => binding.modelType === 'rerank')
      : undefined;
    const rerank = rerankBinding
      ? modelOfType(catalog, rerankBinding.modelId, 'rerank')
      : undefined;
    return {
      embedding: {
        modelId: embedding.modelId,
        dimension: embedding.dimension,
      },
      ...(rerank
        ? {
            rerank: {
              modelId: rerank.modelId,
              dimension: rerank.dimension ?? 768,
            },
          }
        : {}),
    };
  }

  async fullTextRecall(
    input: {
      knowledgeSpaceId: string;
      sourceIds?: readonly string[];
      text: string;
      limit: number;
      options: { timeoutMs: number };
    },
    context: TenantContext,
  ) {
    const workspaceId = requireWorkspaceId(context);
    const knowledgeSpaceId = objectIdOf(input.knowledgeSpaceId, context, 'knowledgeSpaceId');
    const models = registerKnowledgeModels(this.connection);
    const match: Record<string, unknown> = {
      workspaceId,
      knowledgeSpaceId,
      deletedAt: null,
      searchEnabled: true,
      indexStatus: 'indexed',
      $text: { $search: input.text },
    };
    if (input.sourceIds !== undefined) {
      match.sourceId = {
        $in: input.sourceIds.map((sourceId) => objectIdOf(sourceId, context, 'filters.sourceIds')),
      };
    }
    try {
      const rows = await models.KnowledgeSegment.aggregate<{
        _id: unknown;
        sourceId: unknown;
        fullTextVersion?: string | number;
        score: number;
      }>([
        { $match: match },
        { $addFields: { score: { $meta: 'textScore' } } },
        { $sort: { score: -1, _id: 1 } },
        { $limit: Math.max(1, Math.min(input.limit, 200)) },
        {
          $project: {
            sourceId: 1,
            fullTextVersion: 1,
            score: { $meta: 'textScore' },
          },
        },
      ])
        .option({ maxTimeMS: input.options.timeoutMs })
        .exec();
      return rows.map((row) => ({
        segmentId: String(row._id),
        sourceId: String(row.sourceId),
        ...(row.fullTextVersion !== undefined ? { fullTextVersion: row.fullTextVersion } : {}),
        score: Number(row.score),
      }));
    } catch (error) {
      if ((error as { code?: number }).code === 50) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { dependency: 'mongo', operation: 'full_text_recall' },
        });
      }
      throw createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { dependency: 'mongo', operation: 'full_text_recall' },
      });
    }
  }
}
