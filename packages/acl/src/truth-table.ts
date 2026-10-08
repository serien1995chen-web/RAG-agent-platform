export const ACL_PERMISSION_READ = 1;
export const ACL_PERMISSION_WRITE = 2;
export const ACL_PERMISSION_MANAGE = 4;
export const ACL_PERMISSION_OWNER = 8;
export const ACL_PERMISSION_ALL =
  ACL_PERMISSION_READ | ACL_PERMISSION_WRITE | ACL_PERMISSION_MANAGE | ACL_PERMISSION_OWNER;

export interface TruthTableInput {
  inheritedMask: number;
  explicitMask: number | null;
  isOwner: boolean;
  isRoot: boolean;
}

export function maskTruthTable(input: TruthTableInput): number {
  if (input.isRoot || input.isOwner) return ACL_PERMISSION_ALL;
  if (input.explicitMask !== null) return input.explicitMask & ACL_PERMISSION_ALL;
  return input.inheritedMask & ACL_PERMISSION_ALL;
}

export function mergeTruthTableMasks(...masks: readonly number[]): number {
  return masks.reduce((result, mask) => result | mask, 0) & ACL_PERMISSION_ALL;
}

export function allowsLastOwnerRemoval(ownerCount: number, removingCount = 1): boolean {
  return ownerCount - removingCount >= 1;
}
