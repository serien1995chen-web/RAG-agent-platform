import type { PermissionSnapshotValue } from '../../../ports/capabilities';
/**
 * DatasetAcl 领域骨架（设计文档 7.2 / 7.4）。
 * 该层只允许实体、值对象、不变量与 Port 引用；禁止导入基础设施客户端。
 */
export type DatasetAcl = PermissionSnapshotValue;

export const DATASET_ACL_INVARIANTS = [
  '索引必须归属有效 KnowledgeItem',
  '跨对象引用必须同租户',
] as const;

export function validateDatasetAcl(candidate: Partial<DatasetAcl>): string[] {
  const issues: string[] = [];

  if (candidate.permissionMask === 0 && candidate.inherited)
    issues.push('显式空权限不得与继承同时生效');
  return issues;
}
