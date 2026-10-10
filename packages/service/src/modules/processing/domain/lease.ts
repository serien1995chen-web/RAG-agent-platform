export const PROCESSING_LEASE_MS = 10 * 60 * 1000;
export const PROCESSING_HEARTBEAT_MS = 60 * 1000;
export const PROCESSING_EPOCH_LOCK_TIME = new Date('2000-01-01T00:00:00.000Z');
export const PROCESSING_PERMANENT_LOCK_TIME = new Date('2050-01-01T00:00:00.000Z');
export const PROCESSING_QA_RETRY_WAIT_MS = 10 * 60 * 1000;
export const PROCESSING_VECTOR_RETRY_WAIT_MS = 3 * 60 * 1000;
export const PROCESSING_RETRY_NOT_BEFORE_KEY = '__retryNotBefore';

export type ProcessingBudgetKind = 'initial' | 'rebuild' | 'manual';
export type ProcessingDerivedState =
  | 'active'
  | 'running'
  | 'temporaryFailure'
  | 'final_error'
  | 'blocked';

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

export function retryNotBeforeFromPayload(payload: unknown): Date | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[PROCESSING_RETRY_NOT_BEFORE_KEY];
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function isRetryBackoffElapsed(payload: unknown, now = new Date()): boolean {
  const notBefore = retryNotBeforeFromPayload(payload);
  return notBefore === null || notBefore.getTime() <= now.getTime();
}

export function isClaimWindowOpen(
  lockTime: Date,
  retryCount: number,
  now = new Date(),
  payload?: unknown,
): boolean {
  if (retryCount <= 0 || isPermanentlyLocked(lockTime)) return false;
  if (!isRetryBackoffElapsed(payload, now)) return false;
  const leaseExpireAt = lockTime.getTime() + PROCESSING_LEASE_MS;
  return (
    lockTime.getTime() <= PROCESSING_EPOCH_LOCK_TIME.getTime() || leaseExpireAt <= now.getTime()
  );
}

export function canClaim(
  lockTime: Date,
  retryCount: number,
  now = new Date(),
  payload?: unknown,
): boolean {
  return isClaimWindowOpen(lockTime, retryCount, now, payload);
}

export function retryWaitMs(mode: string): number {
  if (mode === 'qa') return PROCESSING_QA_RETRY_WAIT_MS;
  if (mode === 'vector') return PROCESSING_VECTOR_RETRY_WAIT_MS;
  return 0;
}

export function retryBackoffUntil(mode: string, now = new Date()): Date | null {
  const waitMs = retryWaitMs(mode);
  return waitMs > 0 ? new Date(now.getTime() + waitMs) : null;
}

export function manualRecoveryRetryCount(): number {
  return retryBudget('manual');
}

export function blockedErrorMsg(errorMsg?: string): string {
  if (!errorMsg || errorMsg === 'blocked') return 'blocked';
  return errorMsg.startsWith('blocked:') ? errorMsg : `blocked:${errorMsg}`;
}

export function isBlockedErrorMsg(errorMsg: string | null | undefined): boolean {
  return errorMsg === 'blocked' || errorMsg?.startsWith('blocked:') === true;
}

export function deriveProcessingState(input: {
  retryCount: number;
  lockTime: Date;
  errorMsg?: string | null;
  payload?: unknown;
  now?: Date;
}): ProcessingDerivedState {
  const { retryCount, lockTime, errorMsg = null } = input;
  const now = input.now ?? new Date();
  if (isPermanentlyLocked(lockTime)) {
    return isBlockedErrorMsg(errorMsg) ? 'blocked' : 'final_error';
  }
  if (retryCount <= 0) return 'final_error';
  if (!isRetryBackoffElapsed(input.payload, now)) return 'temporaryFailure';
  const leaseExpireAt = lockTime.getTime() + PROCESSING_LEASE_MS;
  if (lockTime.getTime() > PROCESSING_EPOCH_LOCK_TIME.getTime() && leaseExpireAt > now.getTime()) {
    return 'running';
  }
  return 'active';
}
