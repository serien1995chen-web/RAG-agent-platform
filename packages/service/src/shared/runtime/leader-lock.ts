import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

/** 单例调度的租约锁（设计文档 5.5 / 9.13 / 16.4）：owner 标识 + TTL，过期可被接管。 */
export interface LeaderLock {
  acquire(): Promise<boolean>;
  renew(): Promise<boolean>;
  release(): Promise<void>;
  isHeld(): boolean;
}

export interface LeaderLockOptions {
  redis: Redis;
  key: string;
  ttlMs: number;
  ownerId?: string;
}

const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

export function createLeaderLock(options: LeaderLockOptions): LeaderLock {
  const ownerId = options.ownerId ?? randomUUID();
  let held = false;

  return {
    isHeld: () => held,
    async acquire() {
      const result = await options.redis.set(options.key, ownerId, 'PX', options.ttlMs, 'NX');
      held = result === 'OK';
      return held;
    },
    async renew() {
      if (!held) return false;
      const result = await options.redis.eval(RENEW_SCRIPT, 1, options.key, ownerId, options.ttlMs);
      held = Number(result) === 1;
      return held;
    },
    async release() {
      if (!held) return;
      await options.redis.eval(RELEASE_SCRIPT, 1, options.key, ownerId);
      held = false;
    },
  };
}
