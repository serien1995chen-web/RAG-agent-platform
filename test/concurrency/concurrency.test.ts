import { describe, expect, it } from 'vitest';
import {
  MemoryIdempotencyStore,
  buildIdempotencyScopeKey,
  buildParseJobId,
  buildSyncJobId,
} from '../../packages/dal/src/index';
import { canRemoveOwner } from '../../packages/acl/src/index';
import {
  PROCESSING_PERMANENT_LOCK_TIME,
  canClaim,
  manualRecoveryRetryCount,
} from '../../packages/service/src/modules/processing/domain/lease';

describe('REP: idempotency and stable job ids', () => {
  it('lets exactly one concurrent identical request win', async () => {
    const store = new MemoryIdempotencyStore();
    const scope = buildIdempotencyScopeKey('team-a', 'POST', '/api/x', 'race-1');
    const results = await Promise.all([store.begin(scope, 'hash'), store.begin(scope, 'hash')]);
    expect(results.filter((result) => result.kind === 'started')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'conflict')).toHaveLength(1);
  });

  it('produces deterministic, collision-free job ids from scope inputs', () => {
    expect(buildParseJobId('t1', 'd1', 'c1', 1)).toBe(buildParseJobId('t1', 'd1', 'c1', 1));
    expect(buildParseJobId('t1', 'd1', 'c1', 1)).not.toBe(buildParseJobId('t1', 'd1', 'c1', 2));
  });

  it('keeps last-owner protection deterministic under repeated checks', () => {
    expect(canRemoveOwner(2, 1)).toBe(true);
    expect(canRemoveOwner(1, 1)).toBe(false);
    expect(canRemoveOwner(0, 1)).toBe(false);
  });

  it('keeps stable sync ids and recovery caps deterministic', () => {
    expect(buildSyncJobId('team-a', 'dataset-a')).toBe(buildSyncJobId('team-a', 'dataset-a'));
    expect(manualRecoveryRetryCount()).toBe(3);
    expect(canClaim(PROCESSING_PERMANENT_LOCK_TIME, 3, new Date('2049-12-31T23:59:59Z'))).toBe(
      false,
    );
  });
});
