import type { KnowledgeBaseSnapshot } from '../../../ports/types';
/**
 * KnowledgeBase 领域骨架（设计文档 7.2 / 7.4）。
 * 该层只允许实体、值对象、不变量与 Port 引用；禁止导入基础设施客户端。
 */
export type KnowledgeBase = KnowledgeBaseSnapshot;

export const KNOWLEDGE_BASE_INVARIANTS = [
  'teamId 必填且不可随请求覆盖',
  '跨对象引用必须同租户',
] as const;

export function validateKnowledgeBase(candidate: Partial<KnowledgeBase>): string[] {
  const issues: string[] = [];
  if (!candidate.teamId) issues.push('teamId 必填且不可随请求覆盖');
  if (!candidate.type) issues.push('type 必须为合法 Dataset/Folder 类型');
  return issues;
}
