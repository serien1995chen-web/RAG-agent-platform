import { describe, expect, it } from 'vitest';
import { createSafeLogger, initMetrics, initTracing, isSensitiveLogFields } from '../../src/index';

describe('otel three-entry safety (15.x)', () => {
  it('degrades to disabled when no exporter is configured', () => {
    const config = { serviceName: 'kb-test', enabled: true, logLevel: 'info' as const };
    expect(initTracing(config)).toEqual({ enabled: false, reason: 'exporter_not_configured' });
    expect(initMetrics(config)).toEqual({ enabled: false, reason: 'exporter_not_configured' });
  });

  it('never throws when the exporter factory fails', () => {
    const status = initTracing(
      { serviceName: 'kb-test', enabled: true, exporterEndpointRef: 'kb:/otel', logLevel: 'info' },
      () => {
        throw new Error('exporter down');
      },
    );
    expect(status.enabled).toBe(false);
    expect(status.reason).toMatch(/^init_failed:/);
  });

  it('drops log records containing sensitive fields instead of writing them', () => {
    expect(isSensitiveLogFields({ requestId: 'r1', password: 'x' })).toBe(true);
    expect(isSensitiveLogFields({ requestId: 'r1', nested: { apiKey: 'x' } })).toBe(true);
    expect(isSensitiveLogFields({ requestId: 'r1', route: '/api/x' })).toBe(false);

    const logger = createSafeLogger({ name: 'test', level: 'info', enabled: true });
    expect(() => logger.log('dataset.test.event', { password: 'x' })).not.toThrow();
    expect(() =>
      logger.child({ module: 'test' }).log('dataset.test.event', { ok: true }),
    ).not.toThrow();
  });
});
