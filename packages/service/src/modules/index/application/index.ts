import type { RequestContext } from '../../../ports/types';
import type { VectorController } from '../../../ports/capabilities';
import type { PortCallOptions } from '../../../ports/types';
import type { VectorSearchHit } from '../../../ports/capabilities';

export interface IndexServiceDeps {
  repository: VectorController;
}

/** KnowledgeItemIndex 应用编排骨架：只依赖 Port，不直接拼装存储查询。 */
export class IndexApplicationService {
  constructor(private readonly deps: IndexServiceDeps) {}

  recallVectors(
    input: {
      teamId: string;
      datasetId: string;
      collectionId?: string;
      vector: number[];
      limit: number;
      indexVersion?: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<VectorSearchHit[]> {
    return this.deps.repository.embRecall(input, context);
  }
}
