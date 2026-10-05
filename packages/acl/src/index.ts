/**
 * @kb/acl — 权限位与权限真值表（CR-FEATURE-08，设计文档 13.3-13.5）。
 * 显式空权限（mask=0）必须保持 deny；Owner/Root 覆盖为全部权限；最后一名 Owner 不得移除。
 */
export const PACKAGE_NAME = '@kb/acl' as const;

export const PERMISSION_READ = 1;
export const PERMISSION_WRITE = 2;
export const PERMISSION_MANAGE = 4;
export const PERMISSION_OWNER = 8;
export const PERMISSION_ALL =
  PERMISSION_READ | PERMISSION_WRITE | PERMISSION_MANAGE | PERMISSION_OWNER;

export type PermissionBit =
  | typeof PERMISSION_READ
  | typeof PERMISSION_WRITE
  | typeof PERMISSION_MANAGE
  | typeof PERMISSION_OWNER;

export function hasPermission(mask: number, bit: PermissionBit): boolean {
  return (mask & bit) === bit;
}

export function mergePermissions(...masks: readonly number[]): number {
  return masks.reduce((result, mask) => result | mask, 0) & PERMISSION_ALL;
}

export interface PermissionEvaluationInput {
  inheritedMask: number;
  /** null 表示没有个人 ACL 行；0 表示显式 deny。 */
  explicitMask: number | null;
  isOwner: boolean;
  isRoot: boolean;
}

/** 设计文档 13.4 的 ACL 真值表优先级：Root/Owner > 显式 deny > 继承并集。 */
export function evaluatePermission(input: PermissionEvaluationInput): number {
  if (input.isRoot || input.isOwner) return PERMISSION_ALL;
  if (input.explicitMask !== null) return input.explicitMask & PERMISSION_ALL;
  return input.inheritedMask & PERMISSION_ALL;
}

export function canRemoveOwner(ownerCount: number, removingCount = 1): boolean {
  return ownerCount - removingCount >= 1;
}
