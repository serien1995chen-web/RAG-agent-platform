import Redis from '../../packages/service/node_modules/ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNTIME_ROUTE_REGISTRY_BY_ID } from '../../packages/contracts/src/openapi/route-registry';
import { RedisKnowledgeRateLimiter } from '../../packages/service/src/modules/knowledge/adapter/rate-limit.adapter';

const clients: Redis[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    if (client.status === 'ready') await client.quit();
    else client.disconnect();
  }
});

describe('L1-B19-API-001 dependency failure semantics', () => {
  it('L1-B19-API-001-F01 Redis rate-limit outage fails closed instead of allowing unlimited traffic', async () => {
    const route = RUNTIME_ROUTE_REGISTRY_BY_ID.get('API-APIKEY-LIST');
    expect(route).toBeDefined();
    const redis = new Redis('redis://127.0.0.1:6399/0', {
      lazyConnect: true,
      connectTimeout: 300,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    clients.push(redis);
    const limiter = new RedisKnowledgeRateLimiter(redis);
    await expect(
      limiter.consume({
        workspaceId: 'ws_b19_redis_fault',
        route: route!,
      }),
    ).rejects.toBeTruthy();
  });
});
