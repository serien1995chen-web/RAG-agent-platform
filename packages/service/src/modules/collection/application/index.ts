import type { RequestContext } from '../../../ports/types';
import type { CollectionRepository } from '../../../ports/repositories';
import type { PortCallOptions } from '../../../ports/types';
import type { CollectionSnapshot, PageResult } from '../../../ports/types';

export interface SourceCollectionServiceDeps {
  repository: CollectionRepository;
}

/** SourceCollection 应用编排骨架：只依赖 Port，不直接拼装存储查询。 */
export class SourceCollectionApplicationService {
  constructor(private readonly deps: SourceCollectionServiceDeps) {}

  listCollections(
    input: {
      datasetId: string;
      parentId?: string | null;
      page: number;
      limit: number;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<PageResult<CollectionSnapshot>> {
    return this.deps.repository.list(input, context);
  }
}
