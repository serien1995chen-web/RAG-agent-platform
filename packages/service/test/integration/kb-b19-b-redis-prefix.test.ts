import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BullMqQueueAdapter, RedisIdempotencyStore } from '@kb/dal';
import type { RouteEntry } from '@kb/contracts';
import { RedisKnowledgeRateLimiter } from '../../src/modules/knowledge/adapter/rate-limit.adapter';

const runId = process.env.B19_B_RUN_ID ?? 'b19-b-redis-prefix';
const prefix = `b19-b:${runId}`;
const queuePrefix = `${prefix}:bull`;
const redisUrl = process.env.KB_TEST_REDIS_URL?.trim();
let redis: Redis;

async function keys(pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    found.push(...batch);
  } while (cursor !== '0');
  return found;
}

async function cleanup(): Promise<void> {
  const owned = await keys(`${prefix}:*`);
  if (owned.length > 0) await redis.del(...owned);
}

beforeAll(async () => {
  if (!redisUrl) throw new Error('missing required test environment: KB_TEST_REDIS_URL');
  redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  await redis.ping();
  await cleanup();
});

afterAll(async () => {
  if (!redis) return;
  await cleanup();
  await redis.quit();
});

describe('L1-B19-OPS-005-Q01 Redis and BullMQ isolation', () => {
  it('prefixes queue, idempotency and rate-limit keys without adding global queue keys', async () => {
    const globalBefore = (await keys('bull:knowledge-*')).length;
    const adapter = new BullMqQueueAdapter({
      connection: redis,
      prefix: queuePrefix,
    });
    const directQueue = new Queue('knowledge-parse', {
      connection: redis,
      prefix: queuePrefix,
    });
    try {
      const jobId = `k_${'a'.repeat(40)}`;
      await expect(
        adapter.enqueue('knowledge-parse', jobId, { runId, workspaceId: runId }),
      ).resolves.toEqual({ jobId, enqueued: true });
      await directQueue.add('probe', { runId });
      const idempotency = new RedisIdempotencyStore(redis, 60, prefix);
      await idempotency.begin(`kb-idem:${runId}:POST:/probe:key-${runId}`, 'hash');
      const limiter = new RedisKnowledgeRateLimiter(redis, prefix);
      await limiter.consume({
        workspaceId: runId,
        route: { operationId: 'B19-PROBE', rateLimit: '10' } as RouteEntry,
      });

      const owned = await keys(`${prefix}:*`);
      expect(owned.length).toBeGreaterThan(0);
      expect(owned.every((key) => key.startsWith(prefix))).toBe(true);
      expect(owned.some((key) => key.includes(':bull:knowledge-parse:'))).toBe(true);
      expect(owned.some((key) => key.includes(':kb-idem:'))).toBe(true);
      expect(owned.some((key) => key.includes(':kb-rate:'))).toBe(true);
      expect((await keys('bull:knowledge-*')).length).toBe(globalBefore);
    } finally {
      await directQueue.close();
      await adapter.close();
    }
  });
});
