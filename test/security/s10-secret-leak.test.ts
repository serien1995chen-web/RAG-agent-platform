import { describe, expect, it, vi } from 'vitest';
import { safeAuditDiff } from '../../packages/service/src/shared/persistence/knowledge/audit';
import { withIdempotency } from '../../projects/app/src/shared/knowledge-api/handler';

describe('TEST-X-SECRET-LEAK consolidated persistence boundary', () => {
  it('redacts secrets and never persists a one-time API Key response', async () => {
    expect(
      safeAuditDiff({
        authorization: 'Bearer kn_live_secret',
        objectKey: 'workspace/object/raw',
        body: 'private',
        promptVersion: 's10.secret.v1',
        connectionString: 'mongodb://user:password@example/db',
        ip: '203.0.113.10',
        userAgent: 'agent',
      }),
    ).toEqual({
      authorization: '[REDACTED]',
      objectKey: '[REDACTED]',
      body: '[REDACTED]',
      promptVersion: 's10.secret.v1',
      connectionString: '[REDACTED]',
      ip: '[REDACTED]',
      userAgent: '[REDACTED]',
    });

    const complete = vi.fn(async () => undefined);
    const result = await withIdempotency(
      {
        begin: async () => ({ kind: 'started' as const }),
        complete,
        fail: async () => undefined,
      },
      'scope',
      'hash',
      async () => ({
        status: 201,
        data: { id: '65f1e5b2a1c9d4b7e8f01234' },
        oneTimeSecret: 'kn_live_once_only',
      }),
      'request',
      'trace',
    );
    expect(result.oneTimeSecret).toBe('kn_live_once_only');
    expect(JSON.stringify(complete.mock.calls[0]?.[1])).not.toContain('kn_live_once_only');
  });
});
