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
import { projectFullText } from '../adapter/s06-jieba.tokenizer';

const FULL_TEXT_CACHE_TTL_MS = 10_000;
const FULL_TEXT_CACHE_MAX_ENTRIES = 256;

interface FullTextRecallRow {
  segmentId: string;
  sourceId: string;
  fullTextVersion?: string | number;
  score: number;
}

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
  // Mongo text scans matching a large share of a 1M-Segment Space are expensive.
  // Cache only candidate IDs/scores briefly; ACL and content authorization still
  // run for every request after recall.
  private readonly fullTextCache = new Map<
    string,
    {
      expiresAt: number;
      rows: FullTextRecallRow[];
    }
  >();

  constructor(
    private readonly connection: Connection,
    private readonly catalog: ModelCatalogPort,
  ) {}

  async resolveModels(
    spaceId: string,
    usingRerank: boolean,
    context: TenantContext,
    rerankModelId?: string,
  ): Promise<S7ResolvedModels> {
    try {
      return await this.resolveModelsUnsafe(spaceId, usingRerank, context, rerankModelId);
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
    rerankModelId?: string,
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
    const activeModelId = embeddingBinding?.activeQueryModelId ?? embeddingBinding?.modelId;
    const capabilityDimension = embeddingBinding?.requiredCapabilities
      .find((capability) => /^dimension:(768|1024|1536|3072)$/.test(capability))
      ?.split(':')[1];
    const activeDimension =
      embeddingBinding?.activeQueryDimension ??
      (capabilityDimension ? (Number(capabilityDimension) as 768 | 1024 | 1536 | 3072) : null);
    const embedding = embeddingBinding
      ? modelOfType(catalog, activeModelId ?? '', 'embedding')
      : undefined;
    if (!embedding || embedding.dimension === null || activeDimension === null) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'modelBindings.embedding',
        reason: 'active_binding_required',
      });
    }
    const llmBinding = bindings.find((binding) => binding.modelType === 'llm');
    const llm = llmBinding ? modelOfType(catalog, llmBinding.modelId, 'llm') : undefined;
    const rerankBinding = usingRerank
      ? bindings.find((binding) => binding.modelType === 'rerank')
      : undefined;
    const rerank = usingRerank
      ? rerankModelId
        ? modelOfType(catalog, rerankModelId, 'rerank')
        : rerankBinding
          ? modelOfType(catalog, rerankBinding.modelId, 'rerank')
          : undefined
      : undefined;
    if (usingRerank && rerankModelId && !rerank) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'rerankModelId',
        reason: 'not_authorized_for_type',
      });
    }
    return {
      embedding: {
        modelId: activeModelId ?? embedding.modelId,
        dimension: activeDimension,
      },
      ...(llm
        ? {
            llm: {
              modelId: llm.modelId,
              dimension: llm.dimension ?? 768,
            },
          }
        : {}),
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
    const searchText =
      projectFullText({
        segmentId: 'full-text-query',
        sourceVersion: 0,
        indexVersion: 0,
        question: input.text,
        answer: '',
        content: '',
        searchEnabled: true,
      }).fullTextTokens || input.text;
    const sourceIds = input.sourceIds === undefined ? null : [...input.sourceIds].sort();
    const cacheKey = JSON.stringify([
      workspaceId,
      String(knowledgeSpaceId),
      sourceIds,
      searchText,
      input.limit,
    ]);
    const cached = this.fullTextCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.rows.map((row) => ({ ...row }));
    }
    if (cached) this.fullTextCache.delete(cacheKey);
    const models = registerKnowledgeModels(this.connection);
    const match: Record<string, unknown> = {
      workspaceId,
      knowledgeSpaceId,
      deletedAt: null,
      searchEnabled: true,
      indexStatus: 'indexed',
      $text: { $search: searchText },
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
      const result = rows.map((row) => ({
        segmentId: String(row._id),
        sourceId: String(row.sourceId),
        ...(row.fullTextVersion !== undefined ? { fullTextVersion: row.fullTextVersion } : {}),
        score: Number(row.score),
      }));
      if (this.fullTextCache.size >= FULL_TEXT_CACHE_MAX_ENTRIES) {
        const oldestKey = this.fullTextCache.keys().next().value;
        if (oldestKey !== undefined) this.fullTextCache.delete(oldestKey);
      }
      this.fullTextCache.set(cacheKey, {
        expiresAt: Date.now() + FULL_TEXT_CACHE_TTL_MS,
        rows: result,
      });
      return result.map((row) => ({ ...row }));
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

  search(input: Parameters<S7SearchRepository['fullTextRecall']>[0], context: TenantContext) {
    return this.fullTextRecall(input, context);
  }
}
