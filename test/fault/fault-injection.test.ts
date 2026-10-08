import { describe, expect, it } from 'vitest';
import type { SearchRequest } from '../../packages/contracts/src/index';
import { createSafeLogger, initTracing } from '../../sdk/otel/src/index';
import {
  HealthProbeService,
  classifyRetryableError,
  createDegradedDatasetSearchPort,
} from '../../packages/service/src/index';
import type { RequestContext } from '../../packages/service/src/index';

const context: RequestContext = {
  requestId: 'req-fault',
  tenant: { teamId: 'team-a', tmbId: 'tmb-a', authType: 'internal', isRoot: false },
  permission: { canRead: true, canWrite: false, canManage: false, isOwner: false },
};

describe('FI: dependency and exporter failures never fake success', () => {
  it('turns probe timeouts into failed checks', async () => {
    const health = new HealthProbeService(5);
    health.register({
      name: 'slow-dependency',
      required: true,
      check: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ name: 'slow', status: 'ok', durationMs: 100 }), 50),
        ),
    });
    const checks = await health.checkRequired(context);
    expect(checks[0]?.status).toBe('failed');
  });

  it('records degraded stages instead of returning fabricated search results', async () => {
    const port = createDegradedDatasetSearchPort('integration_test_failure');
    const request: SearchRequest = {
      requestId: 'req-fault',
      teamId: 'team-a',
      datasetIds: ['d1'],
      textQueries: ['hello'],
      imageQueries: [],
      models: { embeddingModel: 'bge-m3' },
      searchMode: 'embedding',
      limit: 10,
      maxTokens: 4000,
      similarity: 0,
    };
    const result = await port.search(request, context);
    expect(result.citations).toEqual([]);
    expect(result.stats.degraded.map((item) => item.stage)).toEqual(['vector', 'fullText']);
    expect(result.stats.degraded[0]?.reason).toBe('integration_test_failure');
  });

  it('keeps otel exporter failures out of the business path', () => {
    const status = initTracing(
      { serviceName: 'kb-test', enabled: true, exporterEndpointRef: 'kb:/otel', logLevel: 'info' },
      () => {
        throw new Error('exporter down');
      },
    );
    expect(status.enabled).toBe(false);
    const logger = createSafeLogger({ name: 'fault-test', level: 'info' });
    expect(() => logger.log('dataset.fault.event', { token: 'secret' })).not.toThrow();
  });

  it('classifies transport failures as retryable without faking success', () => {
    expect(classifyRetryableError({ code: 'ECONNRESET' })).toBe('retryable');
    expect(classifyRetryableError({ code: 400 })).toBe('manual');
  });
});
