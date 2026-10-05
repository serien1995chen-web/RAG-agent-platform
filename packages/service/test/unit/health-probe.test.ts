import { describe, expect, it } from 'vitest';
import { HealthProbeService, liveProbeResponse } from '../../src/index';

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
});
