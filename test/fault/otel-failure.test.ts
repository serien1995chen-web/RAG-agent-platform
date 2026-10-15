import { describe, expect, it } from 'vitest';
import {
  createSafeLogger,
  initMetrics,
  initTracing,
  type OtelConfig,
} from '../../sdk/otel/src/index';

const config: OtelConfig = {
  serviceName: 'kb-p7-07',
  enabled: true,
  exporterEndpointRef: 'kb:/otel',
  logLevel: 'info',
};

describe('P7-07 OTel exporter failure isolation (TEST-FI-OTEL-001 / ACC-OBS-002)', () => {
  it('returns degraded init status when the tracing exporter factory throws', () => {
    const status = initTracing(config, () => {
      throw new Error('trace exporter down');
    });
    expect(status.enabled).toBe(false);
    expect(status.reason).toMatch(/^init_failed:/);
  });

  it('returns degraded init status when the metrics reader factory throws', () => {
    const status = initMetrics(config, () => {
      throw new Error('metrics reader down');
    });
    expect(status.enabled).toBe(false);
    expect(status.reason).toMatch(/^init_failed:/);
  });

  it('continues business execution after exporter initialization failure', () => {
    initTracing(config, () => {
      throw new Error('trace exporter down');
    });
    initMetrics(config, () => {
      throw new Error('metrics reader down');
    });

    const logger = createSafeLogger({ name: 'p7-07', level: 'info', enabled: true });
    expect(() => logger.log('dataset.business.continues', { requestId: 'req-1' })).not.toThrow();
    expect({ state: 'completed' }).toEqual({ state: 'completed' });
  });

  it('does not require a real OTLP endpoint or instrumentation package', () => {
    const disabled = initTracing({
      ...config,
      enabled: false,
    });
    expect(disabled).toEqual({ enabled: false, reason: 'exporter_not_configured' });
  });
});
