import type { SearchRequest, SearchResult } from '@kb/contracts';
import type { RequestContext } from '@kb/service';
import type { ExtensionDescriptor } from '../registry';

/** Agent 只能通过 DatasetSearchPort / 公开 API 读取知识库（设计文档 9.2）。 */
export interface AgentExtensionContract {
  searchKnowledge(request: SearchRequest, context: RequestContext): Promise<SearchResult>;
}

export function createAgentExtension(): ExtensionDescriptor<AgentExtensionContract> {
  return {
    id: 'agent',
    version: '1.0.0',
    capabilities: ['dataset.search'],
    enabled: false,
    implementation: null,
  };
}
