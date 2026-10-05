import type { KnowledgeItemIndexValue } from '../../../ports/types';
/**
 * KnowledgeItemIndex 领域骨架（设计文档 7.2 / 7.4）。
 * 该层只允许实体、值对象、不变量与 Port 引用；禁止导入基础设施客户端。
 */
export type KnowledgeItemIndex = KnowledgeItemIndexValue;

export const KNOWLEDGE_ITEM_INDEX_INVARIANTS = [
  '索引必须归属有效 KnowledgeItem',
  '跨对象引用必须同租户',
] as const;

export function validateKnowledgeItemIndex(candidate: Partial<KnowledgeItemIndex>): string[] {
  const issues: string[] = [];

  if (!candidate.text) issues.push('索引文本不得为空');
  return issues;
}
