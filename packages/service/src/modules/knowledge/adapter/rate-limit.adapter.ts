import type { Redis } from 'ioredis';
import type { RouteEntry } from '@kb/contracts';

export interface KnowledgeRateLimitDecision {
  limit: number;
  remaining: number;
  resetSeconds: number;
  allowed: boolean;
}

const LIMIT_SCRIPT = `
local limit = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4])
local values = redis.call('HMGET', KEYS[1], 'tokens', 'timestamp')
local tokens = tonumber(values[1])
if not tokens then
  tokens = limit
end
local timestamp = tonumber(values[2])
if not timestamp then
  timestamp = now
end
local elapsed = math.max(0, now - timestamp)
tokens = math.min(limit, tokens + elapsed * refillPerMs)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'timestamp', tostring(now))
redis.call('PEXPIRE', KEYS[1], ttlMs)
local resetMs = 0
if tokens < 1 then
  resetMs = math.ceil((1 - tokens) / refillPerMs)
end
return {allowed, math.floor(tokens), resetMs}
`;

export class RedisKnowledgeRateLimiter {
  constructor(private readonly redis: Redis) {}

  async consume(input: {
    workspaceId: string;
    route: RouteEntry;
  }): Promise<KnowledgeRateLimitDecision | null> {
    const limit = Number.parseInt(input.route.rateLimit ?? '', 10);
    if (!Number.isFinite(limit) || limit <= 0) return null;
    const now = Date.now();
    const ttlMs = 2_000;
    const key = `kb-rate:${input.workspaceId}:${input.route.operationId}`;
    const [allowedRaw, remainingRaw, resetRaw] = (await this.redis.eval(
      LIMIT_SCRIPT,
      1,
      key,
      String(limit),
      String(limit / 1_000),
      String(now),
      String(ttlMs),
    )) as [number, number, number];
    const remaining = Math.max(0, Math.floor(Number(remainingRaw)));
    const resetMs = Math.max(1, Math.ceil(Number(resetRaw)));
    return {
      limit,
      remaining,
      resetSeconds: Math.max(1, Math.ceil(resetMs / 1_000)),
      allowed: Number(allowedRaw) === 1,
    };
  }
}
