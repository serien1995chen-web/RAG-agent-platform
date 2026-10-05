import type { Redis } from 'ioredis';

/**
 * 请求级幂等（设计文档 12.5）：scope = teamId + method + path + key，
 * 首个结果缓存 24 小时；同键不同请求体返回 409。
 */
export type IdempotencyState = 'processing' | 'completed' | 'conflict';

export interface IdempotencyRecord {
  state: IdempotencyState;
  requestHash: string;
  response?: unknown;
  createdAtMs: number;
}

export type BeginIdempotencyResult =
  | { kind: 'started' }
  | { kind: 'replay'; record: IdempotencyRecord }
  | { kind: 'conflict'; record: IdempotencyRecord };

export interface IdempotencyStore {
  begin(scopeKey: string, requestHash: string): Promise<BeginIdempotencyResult>;
  complete(scopeKey: string, response: unknown): Promise<void>;
  fail(scopeKey: string): Promise<void>;
}

export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export function buildIdempotencyScopeKey(
  teamId: string,
  method: string,
  path: string,
  key: string,
): string {
  return `kb:idem:${teamId}:${method.toUpperCase()}:${path}:${key}`;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async begin(scopeKey: string, requestHash: string): Promise<BeginIdempotencyResult> {
    const existing = this.records.get(scopeKey);
    if (!existing) {
      this.records.set(scopeKey, { state: 'processing', requestHash, createdAtMs: Date.now() });
      return { kind: 'started' };
    }
    if (existing.requestHash !== requestHash) return { kind: 'conflict', record: existing };
    if (existing.state === 'completed') return { kind: 'replay', record: existing };
    return { kind: 'conflict', record: existing };
  }

  async complete(scopeKey: string, response: unknown): Promise<void> {
    const existing = this.records.get(scopeKey);
    if (!existing) return;
    this.records.set(scopeKey, { ...existing, state: 'completed', response });
  }

  async fail(scopeKey: string): Promise<void> {
    this.records.delete(scopeKey);
  }
}

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number = DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  ) {}

  async begin(scopeKey: string, requestHash: string): Promise<BeginIdempotencyResult> {
    const inserted = await this.redis.set(
      scopeKey,
      JSON.stringify({ state: 'processing', requestHash, createdAtMs: Date.now() }),
      'EX',
      this.ttlSeconds,
      'NX',
    );
    if (inserted === 'OK') return { kind: 'started' };

    const raw = await this.redis.get(scopeKey);
    if (!raw) {
      const retry = await this.redis.set(
        scopeKey,
        JSON.stringify({ state: 'processing', requestHash, createdAtMs: Date.now() }),
        'EX',
        this.ttlSeconds,
        'NX',
      );
      return retry === 'OK'
        ? { kind: 'started' }
        : {
            kind: 'conflict',
            record: { state: 'processing', requestHash, createdAtMs: Date.now() },
          };
    }
    const record = JSON.parse(raw) as IdempotencyRecord;
    if (record.requestHash !== requestHash) return { kind: 'conflict', record };
    return record.state === 'completed' ? { kind: 'replay', record } : { kind: 'conflict', record };
  }

  async complete(scopeKey: string, response: unknown): Promise<void> {
    const raw = await this.redis.get(scopeKey);
    if (!raw) return;
    const record = JSON.parse(raw) as IdempotencyRecord;
    await this.redis.set(
      scopeKey,
      JSON.stringify({ ...record, state: 'completed', response }),
      'EX',
      this.ttlSeconds,
    );
  }

  async fail(scopeKey: string): Promise<void> {
    await this.redis.del(scopeKey);
  }
}
