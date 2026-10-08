import { describe, expect, it } from 'vitest';
import { HealthProbeService, liveProbeResponse, type ProbeResult } from '../../src/index';

const context = {
  requestId: 'req-health',
  tenant: { teamId: 't', tmbId: 'u', authType: 'token' as const, isRoot: false },
  permission: { canRead: true, canWrite: false, canManage: false, isOwner: false },
};

describe('health probes (6.9)', () => {
  it('returns 503 when a required dependency fails', async () => {
    const health = new HealthProbeService(50);
    health.register({
      name: 'mongo',
      required: true,
      check: async () => ({ name: 'mongo', status: 'failed', durationMs: 1 }),
    });
    const summary = health.summarize(await health.checkRequired(context), []);
    expect(summary.httpStatus).toBe(503);
    expect(summary.response.status).toBe('failed');
  });

  it('degrades on optional failures without failing readiness', async () => {
    const health = new HealthProbeService(50);
    health.register({
      name: 'mongo',
      required: true,
      check: async () => ({ name: 'mongo', status: 'ok', durationMs: 1 }),
    });
    health.register({
      name: 'otel',
      required: false,
      check: async () => ({ name: 'otel', status: 'failed', durationMs: 1 }),
    });
    const summary = health.summarize(
      await health.checkRequired(context),
      await health.checkOptional(context),
    );
    expect(summary.httpStatus).toBe(200);
    expect(summary.response.status).toBe('degraded');
  });

  it('turns probe timeouts into failed checks instead of hanging', async () => {
    const health = new HealthProbeService(5);
    health.register({
      name: 'slow',
      required: true,
      check: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ name: 'slow', status: 'ok', durationMs: 100 }), 50),
        ),
    });
    const checks = await health.checkRequired(context);
    expect(checks[0]?.status).toBe('failed');
  });

  it('live probe reports process liveness without dependency details', () => {
    const response = liveProbeResponse();
    expect(response.status).toBe('ok');
    expect(response.checks).toHaveLength(1);
    expect(response.checks[0]?.name).toBe('process');
  });

  it('judges declared dependency versions by the configured policy', async () => {
    const strict = new HealthProbeService(50);
    strict.registerVersionedProbe({
      name: 'mongo',
      required: true,
      dependency: 'mongo',
      policy: 'strict',
      readVersion: async () => '5.0.31',
    });
    const strictSummary = strict.summarize(await strict.checkRequired(context), []);
    expect(strictSummary.httpStatus).toBe(503);
    expect(strictSummary.response.status).toBe('failed');

    const tolerant = new HealthProbeService(50);
    tolerant.registerVersionedProbe({
      name: 'mongo',
      required: true,
      dependency: 'mongo',
      policy: 'degraded',
      readVersion: async () => '5.0.31',
    });
    const tolerantSummary = tolerant.summarize(await tolerant.checkRequired(context), []);
    expect(tolerantSummary.httpStatus).toBe(200);
    expect(tolerantSummary.response.status).toBe('degraded');

    const matched = new HealthProbeService(50);
    matched.registerVersionedProbe({
      name: 'redis',
      required: true,
      dependency: 'redis',
      policy: 'strict',
      readVersion: async () => '7.2.4',
    });
    const matchedSummary = matched.summarize(await matched.checkRequired(context), []);
    expect(matchedSummary.httpStatus).toBe(200);
    expect(matchedSummary.response.status).toBe('ok');
  });

  it('strips version, secret, connection string and tenant fields from responses', async () => {
    const health = new HealthProbeService(50);
    health.register({
      name: 'mongo',
      required: true,
      check: async () =>
        ({
          name: 'mongo',
          status: 'ok',
          durationMs: 1,
          version: '5.0.32',
          connectionString: 'mongodb://user:pass@127.0.0.1:27017/kb',
          tenantId: 'team-a',
        }) as ProbeResult,
    });

    const summary = health.summarize(await health.checkRequired(context), []);
    expect(Object.keys(summary.response.checks[0] ?? {})).toEqual(['name', 'status', 'durationMs']);
    const serialized = JSON.stringify(summary.response);
    expect(serialized).not.toContain('5.0.32');
    expect(serialized).not.toContain('mongodb://');
    expect(serialized).not.toContain('team-a');
  });
});
