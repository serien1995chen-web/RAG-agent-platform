import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { RedisIdempotencyStore, buildIdempotencyScopeKey } from '../../src/index';

const redis = new Redis(process.env.KB_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: 2,
});
const store = new RedisIdempotencyStore(redis, 60);

afterAll(async () => {
  await redis.quit();
});

describe('RedisIdempotencyStore integration (12.5)', () => {
  it('deduplicates by scope key and request hash with TTL', async () => {
    const scope = buildIdempotencyScopeKey('team-a', 'POST', '/api/x', `k-${Date.now()}`);
    try {
      expect(await store.begin(scope, 'hash-1')).toEqual({ kind: 'started' });
      expect((await store.begin(scope, 'hash-1')).kind).toBe('conflict');
      await store.complete(scope, { ok: true });
      const replay = await store.begin(scope, 'hash-1');
      expect(replay.kind).toBe('replay');
      expect((await store.begin(scope, 'hash-2')).kind).toBe('conflict');

      const ttl = await redis.ttl(scope);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    } finally {
      await redis.del(scope);
    }
  });

  it('does not leak scope across teams', async () => {
    const a = buildIdempotencyScopeKey('team-a', 'POST', '/api/x', 'shared-key');
    const b = buildIdempotencyScopeKey('team-b', 'POST', '/api/x', 'shared-key');
    try {
      expect(await store.begin(a, 'hash')).toEqual({ kind: 'started' });
      expect(await store.begin(b, 'hash')).toEqual({ kind: 'started' });
    } finally {
      await redis.del(a, b);
    }
  });
});
