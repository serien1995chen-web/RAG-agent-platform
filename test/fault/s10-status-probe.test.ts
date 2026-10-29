import { describe, expect, it } from 'vitest';
import { S10StatusApplication } from '../../packages/service/src/modules/knowledge/application/s10-status.application';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_status_probe_fault',
  memberId: 'member_status_probe_fault',
  requestId: 'request_status_probe_fault',
  traceId: 'trace_status_probe_fault',
  scopes: ['knowledge:admin'],
};

describe('TEST-OPS-005-BLOCK status probe fault', () => {
  it('degrades to unknown when dependency probes fail', async () => {
    const status = await new S10StatusApplication({
      async probe() {
        throw new Error('probe unavailable');
      },
    }).get(context);
    expect(status.status).toBe('degraded');
    expect(status.dependencies.mongo).toMatchObject({
      status: 'down',
      verificationStatus: 'UNKNOWN',
    });
    expect(status.modelProbe.verificationStatus).toBe('UNKNOWN');
    expect(status.reconciliation.state).toBe('unknown');
  });
});
