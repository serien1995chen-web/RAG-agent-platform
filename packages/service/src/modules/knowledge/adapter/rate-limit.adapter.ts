import type { Redis } from 'ioredis';
import type { RouteEntry } from '@kb/contracts';

export interface KnowledgeRateLimitDecision {
  limit: number;
  remaining: number;
  resetSeconds: number;
  allowed: boolean;
}

const LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

export class RedisKnowledgeRateLimiter {
  constructor(private readonly redis: Redis) {}

  async consume(input: {
    workspaceId: string;
    route: RouteEntry;
  }): Promise<KnowledgeRateLimitDecision | null> {
    const limit = Number.parseInt(input.route.rateLimit ?? '', 10);
    if (!Number.isFinite(limit) || limit <= 0) return null;
    const windowSeconds = 1;
    const bucket = Math.floor(Date.now() / 1000);
    const key = `kb-rate:${input.workspaceId}:${input.route.operationId}:${bucket}`;
    const [usedRaw, ttlRaw] = (await this.redis.eval(
      LIMIT_SCRIPT,
      1,
      key,
      String(windowSeconds * 1000),
    )) as [number, number];
    const used = Number(usedRaw);
    const ttlMs = Math.max(Number(ttlRaw), 1);
    return {
      limit,
      remaining: Math.max(0, limit - used),
      resetSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
      allowed: used <= limit,
    };
  }
}
