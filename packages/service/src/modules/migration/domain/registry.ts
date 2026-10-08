import { ApiErrorException, createApiError } from '@kb/contracts';

export type MigrationState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export function scopeTeamId(scope: unknown): string | null {
  if (typeof scope !== 'object' || scope === null) return null;
  const value = (scope as { teamId?: unknown }).teamId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function assertScopeTenant(scope: unknown, teamId: string, requestId: string): void {
  if (scopeTeamId(scope) !== teamId) {
    throw new ApiErrorException(
      createApiError({
        code: 501070,
        requestId,
        params: { resourceType: 'migration_scope', resourceId: teamId },
      }),
    );
  }
}

export function assertResumeCursor(current: string | null, next: string, requestId: string): void {
  if (current !== null && next <= current) {
    throw new ApiErrorException(
      createApiError({
        code: 501005,
        requestId,
        params: { taskId: 'migration', from: current, to: next },
      }),
    );
  }
}

export function migrationNameOf(version: string): string {
  return `migration:${version}`;
}
