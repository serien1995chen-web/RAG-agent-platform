import { createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';

export const PERMISSION_LEVEL = Object.freeze({
  read: 10,
  write: 20,
  manage: 30,
  owner: 40,
} as const);

export type PermissionLevel = keyof typeof PERMISSION_LEVEL;
export type AclResourceType = 'space' | 'directory' | 'source';
export type SourcePermissionState = 'disabled' | 'inherited' | 'independent';
export type SourcePermissionAction = 'enable' | 'detach' | 'resume' | 'disable';

export function strongerPermission(
  left: PermissionLevel | null,
  right: PermissionLevel | null,
): PermissionLevel | null {
  if (!left) return right;
  if (!right) return left;
  return PERMISSION_LEVEL[left] >= PERMISSION_LEVEL[right] ? left : right;
}

export function permissionAllows(
  actual: PermissionLevel | null,
  required: PermissionLevel,
): boolean {
  return actual !== null && PERMISSION_LEVEL[actual] >= PERMISSION_LEVEL[required];
}

export function transitionSourcePermission(
  current: SourcePermissionState,
  action: SourcePermissionAction,
  context: Pick<TenantContext, 'requestId' | 'traceId'>,
): SourcePermissionState {
  const allowed =
    (current === 'disabled' && action === 'enable') ||
    (current === 'inherited' && ['detach', 'disable'].includes(action)) ||
    (current === 'independent' && ['resume', 'disable'].includes(action));
  if (!allowed) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_CONFLICT',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { current, action, stateMachine: 'source-permission' },
    });
  }
  switch (action) {
    case 'enable':
    case 'resume':
      return 'inherited';
    case 'detach':
      return 'independent';
    case 'disable':
      return 'disabled';
  }
}
