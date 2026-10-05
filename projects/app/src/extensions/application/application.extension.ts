import type { SearchRequest, SearchResult } from '@kb/contracts';
import type { RequestContext } from '@kb/service';
import type { ExtensionDescriptor } from '../registry';

/** 应用/工作流只能通过 DatasetSearchPort 与公开 API 调用知识库；不得反向修改领域模型。 */
export interface ApplicationExtensionContract {
  invoke(
    input: { request: SearchRequest },
    context: RequestContext,
  ): Promise<{ output: SearchResult }>;
}

export function createApplicationExtension(): ExtensionDescriptor<ApplicationExtensionContract> {
  return {
    id: 'application',
    version: '1.0.0',
    capabilities: ['dataset.search'],
    enabled: false,
    implementation: null,
  };
}
