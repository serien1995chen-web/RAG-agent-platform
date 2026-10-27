import type {
  CitationApi,
  MultiSpaceSearchApiRequest,
  SearchApiRequest,
  SearchApiResponse,
} from '../../packages/contracts/src/index';
import type {
  S7DownstreamKnowledgeClient,
  S7DownstreamResult,
} from '../../packages/web/src/client/s7-downstream-knowledge-client';

export class ChatHybridConsumer {
  constructor(private readonly client: S7DownstreamKnowledgeClient) {}

  async answerInput(request: SearchApiRequest): Promise<S7DownstreamResult<SearchApiResponse>> {
    return this.client.searchHybrid(request);
  }
}

export class AgentSemanticConsumer {
  constructor(private readonly client: S7DownstreamKnowledgeClient) {}

  async tool(request: SearchApiRequest): Promise<S7DownstreamResult<SearchApiResponse>> {
    return this.client.searchSemantic(request);
  }

  async citation(citationId: string): Promise<S7DownstreamResult<CitationApi>> {
    return this.client.getCitation(citationId);
  }
}

export class WorkflowMultiConsumer {
  constructor(private readonly client: S7DownstreamKnowledgeClient) {}

  async knowledgeNode(
    request: MultiSpaceSearchApiRequest,
  ): Promise<S7DownstreamResult<SearchApiResponse>> {
    return this.client.searchMultiSpace(request);
  }
}
