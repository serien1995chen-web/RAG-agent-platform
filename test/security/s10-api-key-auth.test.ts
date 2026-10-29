import { describe, expect, it, vi } from 'vitest';
import { KnowledgeApiKeyAuthProvider } from '../../packages/service/src/modules/knowledge/adapter/auth.adapter';
import {
  hashApiKeySecret,
  type S10ApiKeyAuthRecord,
} from '../../packages/service/src/modules/knowledge/domain/s10-api-key';

const hmacSecret = 's10-security-test-hmac-secret-at-least-32-bytes';
const secret = 'kn_live_security-test-secret-0123456789abcdef';

function record(overrides: Partial<S10ApiKeyAuthRecord> = {}): S10ApiKeyAuthRecord {
  return {
    id: '65f1e5b2a1c9d4b7e8f01234',
    workspaceId: 'ws_security',
    name: 'security key',
    keyPrefix: secret.slice(0, 12),
    secretHash: hashApiKeySecret(secret, hmacSecret),
    scopes: ['knowledge:read'],
    spaceIds: ['65f1e5b2a1c9d4b7e8f02222'],
    status: 'active',
    expiresAt: null,
    retireAt: null,
    lastUsedAt: null,
    rotatedFromKeyId: null,
    rotatedToKeyId: null,
    rotatedAt: null,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function provider(stored: S10ApiKeyAuthRecord | null) {
  const markUsed = vi.fn(async () => undefined);
  return {
    markUsed,
    auth: new KnowledgeApiKeyAuthProvider(
      {
        findForAuthentication: async () => stored,
        markUsed,
      },
      hmacSecret,
    ),
  };
}

describe('TEST-X-SECRET-LEAK API Key authentication', () => {
  it('returns a scoped API Key subject without exposing the secret', async () => {
    const { auth, markUsed } = provider(record());
    const subject = await auth.authenticate({
      authorization: `Bearer ${secret}`,
      workspaceId: 'ws_security',
      requestId: 'req-security',
      traceId: 'trace-security',
      ipAddress: '203.0.113.10',
      userAgent: 'security-test-agent',
    });
    expect(subject).toMatchObject({
      authType: 'api_key',
      apiKeyId: '65f1e5b2a1c9d4b7e8f01234',
      apiKeyPrefix: secret.slice(0, 12),
      scopes: ['knowledge:read'],
      spaceIds: ['65f1e5b2a1c9d4b7e8f02222'],
    });
    expect(JSON.stringify(subject)).not.toContain(secret);
    expect(markUsed).toHaveBeenCalledOnce();
  });

  it('rejects wrong secrets, expired keys and absent keys with 401', async () => {
    for (const stored of [
      record({ secretHash: '0'.repeat(64) }),
      record({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      record({ retireAt: new Date(Date.now() - 1_000).toISOString(), status: 'rotated' }),
      null,
    ]) {
      const { auth } = provider(stored);
      await expect(
        auth.authenticate({
          authorization: `Bearer ${secret}`,
          workspaceId: 'ws_security',
          requestId: 'req-security',
          traceId: 'trace-security',
        }),
      ).rejects.toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_AUTH_REQUIRED' } },
      });
    }
  });
});
