import { describe, expect, it, vi } from 'vitest';
import { withIdempotency } from '../../projects/app/src/shared/knowledge-api/handler';

describe('TEST-X-SECRET-LEAK one-time secret idempotency', () => {
  it('persists a replay marker without caching the secret', async () => {
    const complete = vi.fn(async () => undefined);
    const store = {
      begin: vi.fn(async () => ({ kind: 'started' as const })),
      complete,
      fail: vi.fn(async () => undefined),
    };
    const result = await withIdempotency(
      store as never,
      'scope',
      'hash',
      async () => ({
        status: 201,
        data: { id: '65f1e5b2a1c9d4b7e8f01234' },
        oneTimeSecret: 'kn_live_once_only_secret',
      }),
      'request',
      'trace',
    );
    expect(result.oneTimeSecret).toBe('kn_live_once_only_secret');
    const persisted = complete.mock.calls[0]?.[1];
    expect(JSON.stringify(persisted)).not.toContain('kn_live_once_only_secret');
    expect(persisted).toMatchObject({ oneTimeSecretReturned: true });
  });

  it('rejects a replay of a completed one-time-secret response with 409', async () => {
    const store = {
      begin: vi.fn(async () => ({
        kind: 'replay' as const,
        record: {
          response: {
            status: 201,
            data: { id: '65f1e5b2a1c9d4b7e8f01234' },
            oneTimeSecretReturned: true,
          },
        },
      })),
      complete: vi.fn(),
      fail: vi.fn(),
    };
    await expect(
      withIdempotency(
        store as never,
        'scope',
        'hash',
        async () => {
          throw new Error('must not execute');
        },
        'request',
        'trace',
      ),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_CONFLICT',
          details: { reason: 'one_time_secret_already_returned' },
        },
      },
    });
  });
});
