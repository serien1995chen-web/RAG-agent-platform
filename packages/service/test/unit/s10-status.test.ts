import { describe, expect, it } from 'vitest';
import {
  S10StatusApplication,
  type S10StatusProbePort,
  type S10StatusView,
} from '../../src/modules/knowledge/application/s10-status.application';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_status',
  memberId: 'member_status',
  requestId: 'request_status',
  traceId: 'trace_status',
  scopes: ['knowledge:admin'],
  isWorkspaceOwner: true,
};

function view(overrides: Partial<S10StatusView> = {}): S10StatusView {
  const dependency = {
    status: 'ok' as const,
    latencyMs: 1,
    verificationStatus: 'REAL_VERIFIED' as const,
  };
  return {
    status: 'degraded',
    queueDepth: {},
    queueLag: {
      'knowledge-parse': { waiting: 1, delayed: 0, active: 1, failed: 0, lag: 1 },
    },
    storage: { provider: 'minio', healthy: true, verificationStatus: 'REAL_VERIFIED' },
    vector: {
      backend: 'pgvector',
      healthy: true,
      profiles: [768, 1024, 1536, 3072],
      verificationStatus: 'REAL_VERIFIED',
    },
    dependencies: {
      mongo: dependency,
      redis: dependency,
      postgres: dependency,
      s3: dependency,
    },
    modelProbe: {
      status: 'ok',
      verificationStatus: 'REAL_VERIFIED',
      latencyMs: 1,
      modelCount: 2,
    },
    connectorProbes: [],
    queueProbe: dependency,
    connectorProbe: dependency,
    securityChecks: {
      apiKeyHmacConfigured: true,
      scopeEnforced: true,
      auditAppendOnly: true,
      secretRedactionEnabled: true,
      rateLimitEnabled: true,
    },
    reconciliation: {
      lastRunAt: null,
      state: 'unknown',
      orphanObjects: 0,
      orphanVectors: 0,
      diffCount: 0,
      repairedCount: 0,
    },
    ...overrides,
  };
}

function app(value: S10StatusView) {
  const probes: S10StatusProbePort = { probe: async () => value };
  return new S10StatusApplication(probes);
}

describe('S10 status aggregation', () => {
  it('TEST-OPS-005-BLOCK never treats fixture, external or unknown as ok', async () => {
    for (const value of [
      view({ modelProbe: { ...view().modelProbe, verificationStatus: 'FIXTURE_VERIFIED' } }),
      view({
        connectorProbes: [
          {
            connectorId: 'connector',
            provider: 'feishu',
            status: 'active',
            verificationStatus: 'EXTERNAL_UNVERIFIED',
          },
        ],
      }),
      view({
        dependencies: {
          ...view().dependencies,
          redis: {
            status: 'degraded',
            latencyMs: 1,
            verificationStatus: 'UNKNOWN',
          },
        },
      }),
      view({
        queueProbe: {
          status: 'degraded',
          latencyMs: 1,
          verificationStatus: 'UNKNOWN',
          reason: 'queue_probe_failed',
        },
      }),
      view({
        connectorProbe: {
          status: 'degraded',
          latencyMs: 1,
          verificationStatus: 'UNKNOWN',
          reason: 'connector_probe_failed',
        },
      }),
    ]) {
      expect((await app(value).get(context)).status).toBe('degraded');
    }
  });

  it('returns ok only when all necessary probes are genuinely verified', async () => {
    const result = await app(
      view({
        reconciliation: {
          lastRunAt: new Date().toISOString(),
          state: 'ok',
          orphanObjects: 0,
          orphanVectors: 0,
          diffCount: 0,
          repairedCount: 0,
        },
      }),
    ).get(context);
    expect(result.status).toBe('ok');
    expect(result.queueDepth).toEqual({ 'knowledge-parse': 2 });
  });

  it('rejects restricted-Space and non-admin API Keys before probing', async () => {
    let probed = false;
    const application = new S10StatusApplication({
      async probe() {
        probed = true;
        return view();
      },
    });
    await expect(
      application.get({
        ...context,
        apiKeySpaceIds: ['65f1e5b2a1c9d4b7e8f01234'],
      }),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_FORBIDDEN',
          details: { reason: 'workspace_wide_api_key_required' },
        },
      },
    });
    await expect(
      application.get({
        ...context,
        scopes: ['knowledge:read'],
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN', details: { scope: 'knowledge:admin' } } },
    });
    expect(probed).toBe(false);
  });
});
