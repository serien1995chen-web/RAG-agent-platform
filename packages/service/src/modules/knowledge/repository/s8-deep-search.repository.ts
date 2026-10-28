import { createHash } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import { Types, type Connection } from 'mongoose';
import type {
  ModelCatalogItem,
  ModelCatalogPort,
  S5ModelType,
} from '../application/s5-model-ports';
import type { KnowledgeModelBindingDoc } from '../../../shared/persistence/schemas/knowledge-governance.schemas';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { requireWorkspaceId } from '../../../shared/persistence/knowledge/tenant';
import { KnowledgeAuditRepository } from '../../../shared/persistence/knowledge/audit';

function catalogModel(
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

export interface S8DeepModels {
  llm: ModelCatalogItem;
  embedding: ModelCatalogItem & { dimension: 768 | 1024 | 1536 | 3072 };
  rerank?: ModelCatalogItem;
}

export class S8DeepSearchRepository {
  private readonly audit: KnowledgeAuditRepository;

  constructor(
    private readonly connection: Connection,
    private readonly catalog: ModelCatalogPort,
  ) {
    this.audit = new KnowledgeAuditRepository(connection);
  }

  async resolveModels(
    spaceId: string,
    usingRerank: boolean,
    context: TenantContext,
  ): Promise<S8DeepModels> {
    const models = registerKnowledgeModels(this.connection);
    const bindings = (await models.KnowledgeModelBinding.find({
      workspaceId: requireWorkspaceId(context),
      knowledgeSpaceId: new Types.ObjectId(spaceId),
      status: 'active',
      deletedAt: null,
    }).lean()) as unknown as KnowledgeModelBindingDoc[];
    const catalog = await this.catalog.listModels({
      workspaceId: context.workspaceId,
      requestId: context.requestId,
      traceId: context.traceId,
    });
    const llmBinding = bindings.find((binding) => binding.modelType === 'llm');
    const embeddingBinding = bindings.find((binding) => binding.modelType === 'embedding');
    const rerankBinding = usingRerank
      ? bindings.find((binding) => binding.modelType === 'rerank')
      : undefined;
    const llm = llmBinding ? catalogModel(catalog, llmBinding.modelId, 'llm') : undefined;
    const embedding = embeddingBinding
      ? catalogModel(catalog, embeddingBinding.modelId, 'embedding')
      : undefined;
    const rerank = rerankBinding
      ? catalogModel(catalog, rerankBinding.modelId, 'rerank')
      : undefined;
    if (!llm || !embedding || embedding.dimension === null || (usingRerank && !rerank)) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: {
          field: 'modelBindings',
          reason: 'deep_llm_embedding_rerank_required',
        },
      });
    }
    return {
      llm,
      embedding: {
        ...embedding,
        dimension: embedding.dimension as 768 | 1024 | 1536 | 3072,
      },
      ...(rerank ? { rerank } : {}),
    };
  }

  async appendRound(
    input: {
      searchId: string;
      spaceId: string;
      round: number;
      queries: readonly string[];
      candidateCount: number;
      sufficient: boolean;
      modelIds: readonly string[];
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      stopEvidence: Record<string, unknown>;
    },
    context: TenantContext,
  ): Promise<void> {
    await this.audit.appendStandalone(
      {
        knowledgeSpaceId: input.spaceId,
        action: 'knowledge.search.deep.round',
        resourceType: 'space',
        resourceId: input.spaceId,
        outcome: 'succeeded',
        safeDiff: {
          searchId: input.searchId,
          round: input.round,
          queryCount: input.queries.length,
          queryHashes: input.queries.map((query) => ({
            length: [...query].length,
            hash: createHash('sha256').update(query).digest('hex').slice(0, 32),
          })),
          candidateCount: input.candidateCount,
          sufficient: input.sufficient,
          modelIds: input.modelIds,
          durationMs: input.durationMs,
          usage: {
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
          },
          stopEvidence: input.stopEvidence,
        },
      },
      context,
    );
  }
}
