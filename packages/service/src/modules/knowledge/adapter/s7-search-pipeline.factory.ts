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
    return {
      vectors: { embRecall: vectorAdapter.embRecall },
      embedding: {
        embed: (request) => modelAdapter.embed(request, input.context),
      },
      fullText: { search: fullTextAdapter.search },
      ...(input.usingRerank && input.models.rerank
        ? {
            rerank: {
              rerank: (request) => modelAdapter.rerank(request, input.context),
            },
          }
        : {}),
      hydrator: this.input.authorization,
    };
  }
}
