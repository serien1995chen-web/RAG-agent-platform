import { describe, expect, it } from 'vitest';
import { S10StatusApplication } from '../../packages/service/src/modules/knowledge/application/s10-status.application';
import { S10StatusProbesAdapter } from '../../packages/service/src/modules/knowledge/adapter/s10-status-probes.adapter';
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

  it('keeps queue and connector query failures explicit and degraded', async () => {
    const adapter = new S10StatusProbesAdapter({
      config: {
        externalModes: { model: 'mock' },
        s3: { provider: 'minio' },
        s10: {
          apiKeyHmacConfigured: true,
          quota: { requestsPerMinute: 30 },
        },
      } as never,
      connection: {} as never,
      queues: new Map([
        [
          'knowledge-parse',
          {
            async getJobCounts() {
              throw new Error('redis unavailable');
            },
          },
        ],
      ]) as never,
      readiness: async () => ({
        status: 200,
        body: {
          checks: ['mongo', 'redis', 'postgres', 's3'].map((name) => ({
            name,
            status: 'ok',
            latencyMs: 1,
          })),
        },
      }),
      models: {
        async listModels() {
          return [];
        },
      },
      connectors: {
        async list() {
          throw new Error('mongo connector query failed');
        },
      },
    });
    const view = await adapter.probe(context);
    expect(view.queueProbe).toMatchObject({
      status: 'degraded',
      verificationStatus: 'UNKNOWN',
      reason: 'queue_probe_failed',
    });
    expect(view.connectorProbe).toMatchObject({
      status: 'degraded',
      verificationStatus: 'UNKNOWN',
      reason: 'connector_probe_failed',
    });
    expect(view.queueLag).toEqual({});
    expect(view.connectorProbes).toEqual([]);
    await expect(new S10StatusApplication(adapter).get(context)).resolves.toMatchObject({
      status: 'degraded',
    });
  });
});
