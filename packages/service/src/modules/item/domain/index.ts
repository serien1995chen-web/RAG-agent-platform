import type { KnowledgeItemSnapshot, PageResult, RequestContext } from '../../../ports/types';
import type { KnowledgeItemRepository } from '../../../ports/repositories';

export { buildQaDedupKey, normalizeQaText } from './dedup-key';
/**
 * KnowledgeItem 领域骨架（设计文档 7.2 / 7.4）。
 * 该层只允许实体、值对象、不变量与 Port 引用；禁止导入基础设施客户端。
 */
export type KnowledgeItem = KnowledgeItemSnapshot;

export const KNOWLEDGE_ITEM_INVARIANTS = [
  'teamId 必填且不可随请求覆盖',
  '跨对象引用必须同租户',
] as const;

export function validateKnowledgeItem(candidate: Partial<KnowledgeItem>): string[] {
  const issues: string[] = [];
  if (!candidate.teamId) issues.push('teamId 必填且不可随请求覆盖');
  if (!candidate.q && !candidate.imageId) issues.push('q 与 imageId 至少存在一个');
  return issues;
}

export interface KnowledgeItemQueryRepository extends KnowledgeItemRepository {
  list(
    input: {
      collectionId: string;
      page: number;
      limit: number;
      search?: string;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<PageResult<KnowledgeItemSnapshot>>;
  get(
    input: { dataId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<KnowledgeItemSnapshot>;
}
