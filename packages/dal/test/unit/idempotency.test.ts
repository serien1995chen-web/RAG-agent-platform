import { describe, expect, it } from 'vitest';
import { MemoryIdempotencyStore, buildIdempotencyScopeKey } from '../../src/index';

describe('request idempotency (12.5)', () => {
  it('is scoped by workspace + method + path + key', () => {
    expect(buildIdempotencyScopeKey('ws-a', 'post', '/v1/knowledge/x', 'k1')).toBe(
      'kb-idem:ws-a:POST:/v1/knowledge/x:k1',
    );
    expect(buildIdempotencyScopeKey('ws-b', 'post', '/v1/knowledge/x', 'k1')).not.toBe(
      buildIdempotencyScopeKey('ws-a', 'post', '/v1/knowledge/x', 'k1'),
    );
  });

  it('replays completed results and conflicts on different bodies', async () => {
    const store = new MemoryIdempotencyStore();
    const scope = buildIdempotencyScopeKey('ws-a', 'POST', '/v1/knowledge/x', 'k1');
    expect(await store.begin(scope, 'hash-1')).toEqual({ kind: 'started' });
    expect((await store.begin(scope, 'hash-1')).kind).toBe('conflict');
    await store.complete(scope, { ok: true });
    expect((await store.begin(scope, 'hash-1')).kind).toBe('replay');
    expect((await store.begin(scope, 'hash-2')).kind).toBe('conflict');
  });

  it('releases the key after failure so the request can be retried', async () => {
    const store = new MemoryIdempotencyStore();
    const scope = buildIdempotencyScopeKey('ws-a', 'POST', '/v1/knowledge/x', 'k2');
    await store.begin(scope, 'hash');
    await store.fail(scope);
    expect((await store.begin(scope, 'hash')).kind).toBe('started');
  });
});
