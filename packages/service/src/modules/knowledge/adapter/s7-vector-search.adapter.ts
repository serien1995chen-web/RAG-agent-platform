import { createKnowledgeError, type ModelSelection } from '@kb/contracts';
import type { SearchEngineDeps } from '@kb/search';
import type { KnowledgeVectorRepository } from '../../../shared/persistence/pgvector';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { S7BoundModel } from '../application/s7-search.ports';
import type { S7ModelGatewaySearchAdapter } from './s7-model-gateway-search.adapter';

function callWithTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  context: TenantContext,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        createKnowledgeError({
          code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { dependency: 'pgvector', timeoutMs },
        }),
      );
    }, timeoutMs);
  });
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class S7VectorSearchAdapter {
  constructor(
    private readonly input: {
      repository: KnowledgeVectorRepository;
      modelGateway: S7ModelGatewaySearchAdapter;
      embedding: S7BoundModel;
      knowledgeSpaceId: string;
      context: TenantContext;
    },
  ) {}

  embed: SearchEngineDeps['embedding']['embed'] = async (request, _context) =>
    this.input.modelGateway.embed(
      {
        models: request.models as ModelSelection,
        texts: request.texts,
        options: request.options,
      },
      this.input.context,
    );

  embRecall: SearchEngineDeps['vectors']['embRecall'] = async (request, _context) =>
    callWithTimeout(
      this.input.repository.recall(
        {
          workspaceId: this.input.context.workspaceId,
          knowledgeSpaceId: this.input.knowledgeSpaceId,
          ...(request.sourceIds !== undefined ? { sourceIds: request.sourceIds } : {}),
          dimension: this.input.embedding.dimension,
          embeddingModelId: this.input.embedding.modelId,
          vector: request.vector,
          limit: request.limit,
        },
        this.input.context,
      ),
      request.options.timeoutMs,
      this.input.context,
    );
}
