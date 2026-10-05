import { describe, expect, it } from 'vitest';
import {
  MemoryIdempotencyStore,
  buildIdempotencyScopeKey,
  buildParseJobId,
} from '../../packages/dal/src/index';

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
});
