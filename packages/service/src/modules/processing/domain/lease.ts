export const PROCESSING_LEASE_MS = 10 * 60 * 1000;
export const PROCESSING_HEARTBEAT_MS = 60 * 1000;
export const PROCESSING_EPOCH_LOCK_TIME = new Date('2000-01-01T00:00:00.000Z');
export const PROCESSING_PERMANENT_LOCK_TIME = new Date('2050-01-01T00:00:00.000Z');

export type ProcessingBudgetKind = 'initial' | 'rebuild' | 'manual';

export function retryBudget(kind: ProcessingBudgetKind = 'initial'): number {
  switch (kind) {
    case 'rebuild':
      return 50;
    case 'manual':
      return 3;
    case 'initial':
      return 5;
    default:
      return 5;
  }
}

export function initialRetryCount(): number {
  return retryBudget('initial');
}

export function isPermanentlyLocked(lockTime: Date): boolean {
  return lockTime.getTime() >= PROCESSING_PERMANENT_LOCK_TIME.getTime();
}

export function canClaim(lockTime: Date, retryCount: number, now = new Date()): boolean {
  if (retryCount <= 0 || isPermanentlyLocked(lockTime)) return false;
  const leaseExpireAt = lockTime.getTime() + PROCESSING_LEASE_MS;
  return (
    lockTime.getTime() <= PROCESSING_EPOCH_LOCK_TIME.getTime() || leaseExpireAt <= now.getTime()
  );
}
