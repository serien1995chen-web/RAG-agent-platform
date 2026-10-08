import type { PermissionSnapshotValue } from '../../../ports/capabilities';
import type { CollaboratorPermission } from '../../../ports/capabilities';
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

const PERMISSION_READ = 1;
const PERMISSION_WRITE = 2;
const PERMISSION_MANAGE = 4;
const PERMISSION_OWNER = 8;
export const ACL_PERMISSION_ALL =
  PERMISSION_READ | PERMISSION_WRITE | PERMISSION_MANAGE | PERMISSION_OWNER;

export function mergePermissionMasks(...masks: readonly number[]): number {
  return masks.reduce((result, mask) => result | mask, 0) & ACL_PERMISSION_ALL;
}

export function evaluatePermissionMask(input: {
  inheritedMask: number;
  explicitMask: number | null;
  isOwner: boolean;
  isRoot: boolean;
}): number {
  if (input.isRoot || input.isOwner) return ACL_PERMISSION_ALL;
  if (input.explicitMask !== null) return input.explicitMask & ACL_PERMISSION_ALL;
  return input.inheritedMask & ACL_PERMISSION_ALL;
}

export function canRemoveLastOwner(
  currentOwners: readonly CollaboratorPermission[],
  next: readonly CollaboratorPermission[],
): boolean {
  const currentCount = currentOwners.filter((item) => item.collaboratorType === 'owner').length;
  const nextCount = next.filter((item) => item.collaboratorType === 'owner').length;
  return currentCount <= 1 && nextCount < 1;
}
