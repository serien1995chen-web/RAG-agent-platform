import { describe, expect, it } from 'vitest';
import {
  defaultApiKeyExpiry,
  effectiveApiKeyStatus,
  generateApiKeySecret,
  hashApiKeySecret,
  matchesApiKeySecretHash,
  rotateApiKeyState,
  validateApiKeyScopes,
} from '../../src/modules/knowledge/domain/s10-api-key';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'workspace-api-key',
  memberId: 'member-api-key',
  requestId: 'request-api-key',
  traceId: 'trace-api-key',
  scopes: ['knowledge:admin'],
  isWorkspaceOwner: true,
};

describe('S10 API Key domain', () => {
  it('TEST-S10-API-KEY-001 generates a kn_live secret and 12 character prefix', () => {
    const generated = generateApiKeySecret((size) => Buffer.alloc(size, 7));
    expect(generated.secret.startsWith('kn_live_')).toBe(true);
    expect(generated.secret.length).toBeGreaterThanOrEqual(51);
    expect(generated.prefix).toBe(generated.secret.slice(0, 12));
  });

  it('matches a fixed HMAC-SHA-256 vector and rejects a different hash', () => {
    const hash = hashApiKeySecret('The quick brown fox jumps over the lazy dog', 'key');
    expect(hash).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
    expect(matchesApiKeySecretHash(hash, hash)).toBe(true);
    expect(matchesApiKeySecretHash(hash, '0'.repeat(64))).toBe(false);
  });

  it('accepts exactly the frozen scope set and rejects duplicates or unknown scopes', () => {
    expect(
      validateApiKeyScopes(['knowledge:read', 'knowledge:search', 'knowledge:admin'], context),
    ).toEqual(['knowledge:read', 'knowledge:search', 'knowledge:admin']);
    for (const scopes of [
      ['knowledge:read', 'knowledge:read'],
      ['knowledge:read', 'knowledge:unknown'],
      [],
    ]) {
      expect(() => validateApiKeyScopes(scopes, context)).toThrowError(
        expect.objectContaining({
          problem: expect.objectContaining({
            error: expect.objectContaining({ code: 'KNOWLEDGE_API_KEY_SCOPE_INVALID' }),
          }),
        }),
      );
    }
  });

  it('uses 30d/90d defaults and a bounded 24h rotation overlap', () => {
    const now = new Date('2026-10-29T00:00:00.000Z');
    expect(defaultApiKeyExpiry(['knowledge:admin'], now).toISOString()).toBe(
      '2026-11-28T00:00:00.000Z',
    );
    expect(defaultApiKeyExpiry(['knowledge:read'], now).toISOString()).toBe(
      '2027-01-27T00:00:00.000Z',
    );
    expect(
      rotateApiKeyState(
        { status: 'active', expiresAt: new Date('2026-10-30T00:00:00.000Z') },
        now,
      ).retireAt.toISOString(),
    ).toBe('2026-10-30T00:00:00.000Z');
    expect(
      rotateApiKeyState(
        { status: 'active', expiresAt: new Date('2026-12-01T00:00:00.000Z') },
        now,
      ).retireAt.toISOString(),
    ).toBe('2026-10-30T00:00:00.000Z');
  });

  it('marks expiresAt and retireAt boundaries as expired', () => {
    const now = new Date('2026-10-29T00:00:00.000Z');
    expect(
      effectiveApiKeyStatus(
        {
          status: 'active',
          expiresAt: new Date('2026-10-29T00:00:00.000Z'),
          retireAt: null,
        },
        now,
      ),
    ).toBe('expired');
    expect(
      effectiveApiKeyStatus(
        {
          status: 'rotated',
          expiresAt: null,
          retireAt: new Date('2026-10-30T00:00:00.000Z'),
        },
        now,
      ),
    ).toBe('rotated');
  });
});
