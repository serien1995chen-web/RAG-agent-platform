import type { RequestContext } from '../../../ports/types';
import type { KnowledgeItemRepository } from '../../../ports/repositories';
import type { KnowledgeItemSnapshot, PageResult, PortCallOptions } from '../../../ports/types';
import type { KnowledgeItemQueryRepository } from '../domain';

export interface KnowledgeItemServiceDeps {
  repository: KnowledgeItemRepository & Partial<KnowledgeItemQueryRepository>;
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

  async listItems(
    input: {
      collectionId: string;
      page: number;
      limit: number;
      search?: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<PageResult<KnowledgeItemSnapshot>> {
    if (!this.deps.repository.list) return { total: 0, list: [], cursor: null };
    return this.deps.repository.list(input, context);
  }

  async getItem(
    input: { dataId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<KnowledgeItemSnapshot | null> {
    if (!this.deps.repository.get) return null;
    return this.deps.repository.get(input, context);
  }
}
