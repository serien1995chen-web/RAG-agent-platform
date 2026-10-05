import type { RequestContext } from '../../../ports/types';
import type { KnowledgeItemRepository } from '../../../ports/repositories';
import type { PortCallOptions } from '../../../ports/types';
import type { KnowledgeItemSnapshot } from '../../../ports/types';

export interface KnowledgeItemServiceDeps {
  repository: KnowledgeItemRepository;
}

/** KnowledgeItem 应用编排骨架：只依赖 Port，不直接拼装存储查询。 */
export class KnowledgeItemApplicationService {
  constructor(private readonly deps: KnowledgeItemServiceDeps) {}

  bulkUpsertItems(
    input: { items: KnowledgeItemSnapshot[]; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ upserted: number; duplicates: number }> {
    return this.deps.repository.bulkUpsert(input, context);
  }
}
