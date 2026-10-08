import { describe, expect, it } from 'vitest';
import { evaluatePermission } from '../../packages/acl/src/index';
import { validateTenantContext } from '../../packages/service/src/index';
import { assertObjectKeyScope } from '../../sdk/storage/src/index';

describe('TEN: cross-tenant guards', () => {
  it('rejects missing tenant context with stable 501012', () => {
    const result = validateTenantContext(null, 'req-ten');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(501012);
      expect(result.error.severity).toBe('fatal');
    }
  });

  it('rejects a partial tenant context before any storage access', () => {
    const result = validateTenantContext(
      { teamId: 'team-a', tmbId: '', authType: 'token', isRoot: false },
      'req-partial-tenant',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(501012);
  });

  it('rejects cross-team object keys before touching storage (501061)', () => {
    expect(() =>
      assertObjectKeyScope({ bucket: 'b', key: 'temp/team-b/file' }, { teamId: 'team-a' }),
    ).toThrowError(/501061/);
  });

  it('keeps explicit deny at zero permission even when parent inherits full mask', () => {
    expect(
      evaluatePermission({
        inheritedMask: 15,
        explicitMask: 0,
        isOwner: false,
        isRoot: false,
      }),
    ).toBe(0);
  });
});
