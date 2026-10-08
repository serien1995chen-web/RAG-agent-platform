import type { NextApiRequest, NextApiResponse } from 'next';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  MemoryIdempotencyStore,
  RedisIdempotencyStore,
  buildIdempotencyScopeKey,
} from '../../packages/dal/src/index';
import {
  IdempotencyConflictError,
  bodyHashOf,
  buildConflictResponse,
  executeWithIdempotency,
  keyHashOf,
} from '../../projects/app/src/shared/api/idempotency';
import { withApiHandler } from '../../projects/app/src/shared/api/with-api-handler';

const teamA = 'team-a';
const teamB = 'team-b';

function mockPair(options: {
  method: string;
  headers?: Record<string, string>;
  url?: string;
  body?: unknown;
}) {
  const request = {
    method: options.method,
    url: options.url ?? '/api/core/dataset/create',
    headers: { ...(options.headers ?? {}) },
    body: options.body,
  } as unknown as NextApiRequest;
  const response = {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, unknown>,
    setHeader(name: string, value: unknown) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  } as unknown as NextApiResponse & {
    statusCode: number;
    body: unknown;
    headers: Record<string, unknown>;
  };
  return { request, response };
}

describe('请求级幂等（12.5 / REP-CREATE / REP-CONFLICT）', () => {
  it('runs once, completes and replays the cached response for the same body', async () => {
    const store = new MemoryIdempotencyStore();
    const scopeKey = buildIdempotencyScopeKey(teamA, 'POST', '/api/x', 'k-1');
    const requestHash = bodyHashOf({ name: 'dataset' });
    const execute = vi.fn().mockResolvedValue({ status: 200, body: { code: 200, data: 1 } });

    const first = await executeWithIdempotency({
      store,
      scopeKey,
      requestHash,
      requestId: 'req-1',
      execute,
    });
    expect(first).toEqual({ status: 200, body: { code: 200, data: 1 } });
    expect(execute).toHaveBeenCalledTimes(1);

    const replay = await executeWithIdempotency({
      store,
      scopeKey,
      requestHash,
      requestId: 'req-2',
      execute,
    });
    expect(replay).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns a 409 conflict when the same key carries a different body hash', async () => {
    const store = new MemoryIdempotencyStore();
    const scopeKey = buildIdempotencyScopeKey(teamA, 'POST', '/api/x', 'k-2');
    await executeWithIdempotency({
      store,
      scopeKey,
      requestHash: bodyHashOf({ a: 1 }),
      requestId: 'req-1',
      execute: async () => ({ status: 200, body: { ok: true } }),
    });

    const second = executeWithIdempotency({
      store,
      scopeKey,
      requestHash: bodyHashOf({ a: 2 }),
      requestId: 'req-2',
      execute: async () => ({ status: 200, body: { ok: true } }),
    });
    await expect(second).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('lets only one concurrent same-body request execute (processing state)', async () => {
    const store = new MemoryIdempotencyStore();
    const scopeKey = buildIdempotencyScopeKey(teamA, 'POST', '/api/x', 'k-3');
    const requestHash = bodyHashOf({ a: 1 });
    let executions = 0;
    const execute = async () => {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: 200, body: { ok: true } };
    };

    const results = await Promise.allSettled([
      executeWithIdempotency({ store, scopeKey, requestHash, requestId: 'req-1', execute }),
      executeWithIdempotency({ store, scopeKey, requestHash, requestId: 'req-2', execute }),
    ]);

    expect(executions).toBe(1);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(IdempotencyConflictError);
  });

  it('scopes keys by team so the same raw key never hits across teams', async () => {
    const store = new MemoryIdempotencyStore();
    const rawKey = 'shared-client-key';
    const scopeA = buildIdempotencyScopeKey(teamA, 'POST', '/api/x', rawKey);
    const scopeB = buildIdempotencyScopeKey(teamB, 'POST', '/api/x', rawKey);
    expect(scopeA).not.toBe(scopeB);

    const first = await executeWithIdempotency({
      store,
      scopeKey: scopeA,
      requestHash: bodyHashOf({ team: 'a' }),
      requestId: 'req-a',
      execute: async () => ({ status: 200, body: { team: 'a' } }),
    });
    const second = await executeWithIdempotency({
      store,
      scopeKey: scopeB,
      requestHash: bodyHashOf({ team: 'b' }),
      requestId: 'req-b',
      execute: async () => ({ status: 200, body: { team: 'b' } }),
    });

    expect(first.body).toEqual({ team: 'a' });
    expect(second.body).toEqual({ team: 'b' });
  });

  it('writes the 24h TTL on the Redis store', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    const redis = {
      set,
      get: vi.fn(),
      del: vi.fn(),
    } as unknown as ConstructorParameters<typeof RedisIdempotencyStore>[0];

    const store = new RedisIdempotencyStore(redis, DEFAULT_IDEMPOTENCY_TTL_SECONDS);
    const begin = await store.begin('kb:idem:scope', 'hash');

    expect(DEFAULT_IDEMPOTENCY_TTL_SECONDS).toBe(86400);
    expect(begin.kind).toBe('started');
    expect(set).toHaveBeenCalledWith('kb:idem:scope', expect.any(String), 'EX', 86400, 'NX');
  });

  it('maps Redis failures to 501016 (503) without executing the handler', async () => {
    const store = {
      begin: vi.fn().mockRejectedValue(new Error('redis down')),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    const execute = vi.fn();

    await expect(
      executeWithIdempotency({
        store,
        scopeKey: 'kb:idem:scope',
        requestHash: 'hash',
        requestId: 'req-redis-down',
        execute,
      }),
    ).rejects.toMatchObject({
      error: { code: 501016, params: { store: 'redis', operation: 'idempotency' } },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('builds the single protocol-level 409 envelope without leaking the raw key', () => {
    const response = buildConflictResponse('req-conflict', keyHashOf('raw-secret-key'));
    expect(response).toMatchObject({
      code: 409,
      messageKey: 'common.conflict',
      errorType: 'conflict',
      data: null,
    });
    expect(JSON.stringify(response)).not.toContain('raw-secret-key');
  });

  it('keeps the body hash stable under key reordering', () => {
    expect(bodyHashOf({ b: 1, a: { d: 2, c: 3 } })).toBe(bodyHashOf({ a: { c: 3, d: 2 }, b: 1 }));
    expect(keyHashOf('secret')).not.toContain('secret');
  });

  it('keeps requests without an Idempotency-Key unchanged', async () => {
    const handler = vi.fn(
      async (_request: NextApiRequest, response: NextApiResponse): Promise<void> => {
        response.status(200).json({ ok: true });
      },
    );
    const wrapped = withApiHandler(handler);
    const { request, response } = mockPair({ method: 'POST', body: { name: 'dataset' } });

    await wrapped(request, response);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});
