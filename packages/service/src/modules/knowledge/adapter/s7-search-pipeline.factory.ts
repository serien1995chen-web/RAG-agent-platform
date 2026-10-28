import type { SearchEngineDeps } from '@kb/search';
import type {
  S7FullTextSearchPort,
  S7SearchPipelineFactoryInput,
  S7SearchPipelineFactoryPort,
} from '../application/s7-search.ports';
import type { KnowledgeVectorRepository } from '../../../shared/persistence/pgvector';
import type { S7CandidateAuthorizationPort } from '../application/s7-search.ports';
import type { S5ModelGatewayPort } from '../application/s5-model-gateway.port';
import { S7FullTextSearchAdapter } from './s7-fulltext-search.adapter';
import { S7ModelGatewaySearchAdapter } from './s7-model-gateway-search.adapter';
import { S7VectorSearchAdapter } from './s7-vector-search.adapter';

export class S7SearchPipelineFactory implements S7SearchPipelineFactoryPort {
  constructor(
    private readonly input: {
      vectors: KnowledgeVectorRepository;
      modelGateway: S5ModelGatewayPort;
      fullText: S7FullTextSearchPort;
      authorization: S7CandidateAuthorizationPort;
    },
  ) {}

  create(input: S7SearchPipelineFactoryInput): SearchEngineDeps {
    const modelAdapter = new S7ModelGatewaySearchAdapter({
      gateway: this.input.modelGateway,
      knowledgeSpaceId: input.space.spaceId,
      embedding: input.models.embedding,
      ...(input.models.rerank ? { rerank: input.models.rerank } : {}),
    });
    const vectorAdapter = new S7VectorSearchAdapter({
      repository: this.input.vectors,
      modelGateway: modelAdapter,
      embedding: input.models.embedding,
      knowledgeSpaceId: input.space.spaceId,
      context: input.context,
    });
    const fullTextAdapter = new S7FullTextSearchAdapter({
      search: (request) => this.input.fullText.search(request, input.context),
    });
    const modelUsage = { inputTokens: 0, outputTokens: 0 };
    const recordUsage = (usage: { inputTokens: number; outputTokens: number }) => {
      modelUsage.inputTokens += usage.inputTokens;
      modelUsage.outputTokens += usage.outputTokens;
    };
    return {
      modelUsage,
      vectors: { embRecall: vectorAdapter.embRecall },
      embedding: {
        embed: async (request) => {
          const result = await modelAdapter.embedWithUsage(request, input.context);
          recordUsage(result.usage);
          return result.vectors;
        },
      },
      fullText: { search: fullTextAdapter.search },
      ...(input.usingRerank && input.models.rerank
        ? {
            rerank: {
              rerank: async (request) => {
                const result = await modelAdapter.rerankWithUsage(request, input.context);
                recordUsage(result.usage);
                return result.ranked;
              },
            },
          }
        : {}),
      hydrator: this.input.authorization,
    };
  }
}
