import type { RequestContext } from '../../../ports/types';
import type { KnowledgeBaseRepository } from '../../../ports/repositories';
import type { PortCallOptions } from '../../../ports/types';
import type { KnowledgeBaseSnapshot } from '../../../ports/types';

export interface KnowledgeBaseServiceDeps {
  repository: KnowledgeBaseRepository;
}

/** KnowledgeBase 应用编排骨架：只依赖 Port，不直接拼装存储查询。 */
export class KnowledgeBaseApplicationService {
  constructor(private readonly deps: KnowledgeBaseServiceDeps) {}

  getDataset(
    input: { datasetId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<KnowledgeBaseSnapshot> {
    return this.deps.repository.get(input, context);
  }
}
