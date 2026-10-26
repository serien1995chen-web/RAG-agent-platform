import { describe, expect, it } from 'vitest';
import { MockReferenceRegistryAdapter } from '../../src/modules/knowledge';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_reference_test',
  memberId: 'mem_reference_test',
  requestId: 'req_reference_test',
  traceId: 'trace_reference_test',
  scopes: ['knowledge:read'],
};

describe('reference registry mock contract', () => {
  it('returns registered referrers with EXTERNAL_UNVERIFIED status', () => {
    const registry = new MockReferenceRegistryAdapter();
    registry.register({
      referrerType: 'workflow',
      referrerId: 'workflow-1',
      referrerVersion: 'v1',
      referrerName: 'Workflow one',
    });
    expect(registry.resolve('workflow', 'workflow-1', 'v1', context)).toEqual({
      referrerType: 'workflow',
      referrerId: 'workflow-1',
      referrerVersion: 'v1',
      referrerName: 'Workflow one',
      verification: 'EXTERNAL_UNVERIFIED',
    });
  });

  it('rejects unregistered integrations without claiming real verification', () => {
    const registry = new MockReferenceRegistryAdapter();
    expect(() => registry.resolve('app', 'missing', 'v1', context)).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({
            code: 'KNOWLEDGE_VALIDATION_FAILED',
            details: expect.objectContaining({
              reason: 'unregistered_reference',
              verification: 'EXTERNAL_UNVERIFIED',
            }),
          }),
        }),
      }),
    );
  });
});
