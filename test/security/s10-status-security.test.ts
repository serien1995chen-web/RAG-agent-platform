import { describe, expect, it } from 'vitest';
import {
  S10StatusApplication,
  type S10StatusView,
} from '../../packages/service/src/modules/knowledge/application/s10-status.application';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_status_security',
  memberId: 'member_status_security',
  requestId: 'request_status_security',
  traceId: 'trace_status_security',
  scopes: ['knowledge:admin'],
};

const verified = {
  status: 'ok' as const,
  latencyMs: 1,
  verificationStatus: 'REAL_VERIFIED' as const,
};

function view(): S10StatusView {
  return {
    status: 'degraded',
    queueDepth: {},
    queueLag: {},
    storage: { provider: 'minio', healthy: true, verificationStatus: 'REAL_VERIFIED' },
    vector: {
      backend: 'pgvector',
      healthy: true,
      profiles: [768, 1024, 1536, 3072],
      verificationStatus: 'REAL_VERIFIED',
    },
    dependencies: {
      mongo: verified,
      redis: verified,
      postgres: verified,
      s3: verified,
    },
    modelProbe: {
      status: 'ok',
      verificationStatus: 'REAL_VERIFIED',
      latencyMs: 1,
    },
    connectorProbes: [],
    queueProbe: verified,
    connectorProbe: verified,
    securityChecks: {
      apiKeyHmacConfigured: true,
      scopeEnforced: true,
      auditAppendOnly: true,
      secretRedactionEnabled: true,
      rateLimitEnabled: true,
    },
    reconciliation: {
      lastRunAt: null,
      state: 'ok',
      orphanObjects: 0,
      orphanVectors: 0,
      diffCount: 0,
      repairedCount: 0,
    },
  };
}

describe('TEST-S10-STATUS-SECURITY security summary', () => {
  it('returns only boolean security facts without secret paths or credentials', async () => {
    const result = await new S10StatusApplication({ probe: async () => view() }).get(context);
    expect(result.securityChecks).toEqual({
      apiKeyHmacConfigured: true,
      scopeEnforced: true,
      auditAppendOnly: true,
      secretRedactionEnabled: true,
      rateLimitEnabled: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/kn_live_|Bearer|TOKEN_FILE|\/run\/secrets/i);
  });

  it('rejects restricted-Space keys before exposing status data', async () => {
    let probes = 0;
    const application = new S10StatusApplication({
      async probe() {
        probes += 1;
        return view();
      },
    });
    await expect(
      application.get({
        ...context,
        apiKeySpaceIds: ['65f1e5b2a1c9d4b7e8f01234'],
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    expect(probes).toBe(0);
  });
});
