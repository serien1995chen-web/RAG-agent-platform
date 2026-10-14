import { describe, expect, it } from 'vitest';
import {
  ALERT_KINDS,
  LOG_FIELD_DICTIONARY,
  SPAN_INSTRUMENTS,
  createAlertSignal,
  createSafeLogger,
  startInstrumentSpan,
} from '../../sdk/otel/src/index';
import {
  INSTRUMENT_CLASSES,
  METRIC_DEFINITIONS,
  METRIC_NAMES,
  metricDropCount,
  recordMetric,
} from '../../packages/service/src/shared/observability/instruments';

describe('P7-07 observability contracts (ACC-OBS-001..008 / TEST-OBS-TRACE-001 / TEST-API-MASK-001)', () => {
  it('fixes 43 metrics, 13 instruments, 13 log fields, and 7 alert kinds', () => {
    expect(METRIC_DEFINITIONS).toHaveLength(43);
    expect(METRIC_NAMES).toEqual(METRIC_DEFINITIONS.map((entry) => entry.name));
    expect(new Set(METRIC_NAMES).size).toBe(43);
    expect(INSTRUMENT_CLASSES).toHaveLength(13);
    expect(Object.keys(SPAN_INSTRUMENTS)).toHaveLength(13);
    expect(LOG_FIELD_DICTIONARY).toHaveLength(13);
    expect(ALERT_KINDS).toHaveLength(7);
  });

  it('keeps teamId out of global metric labels and drops non-whitelisted attributes', () => {
    expect(
      METRIC_DEFINITIONS.every((entry) => !entry.allowedAttributes.includes('teamId')),
    ).toBe(true);
    const calls: Array<{ name: string; attributes: Record<string, string> }> = [];
    const port = {
      record: (name: string, _value: number, attributes: Record<string, string>) => {
        calls.push({ name, attributes });
      },
    };
    expect(
      recordMetric(port, 'dataset_http_requests_total', 1, {
        method: 'GET',
        route: '/api/x',
        teamId: 'team-a',
      }),
    ).toEqual({ recorded: true, dropped: 'attribute_not_allowed' });
    expect(calls[0]?.attributes).toEqual({ method: 'GET', route: '/api/x' });
  });

  it('associates trace requestId without exporting forbidden attributes', async () => {
    expect(SPAN_INSTRUMENTS.http.allowedAttributes).toContain('requestId');
    const result = await startInstrumentSpan(
      'http',
      'http.request',
      { requestId: 'req-1', route: '/api/x', rawResponse: 'secret' },
      async () => 'ok',
      { httpStatus: 200 },
    );
    expect(result).toBe('ok');
  });

  it('drops sensitive log records and increments the fixed drop counter', () => {
    const logger = createSafeLogger({ name: 'p7-07', level: 'info', enabled: true });
    const before = logger.droppedRecords();
    logger.log('dataset.test.event', { apiKey: 'x' });
    expect(logger.droppedRecords()).toBe(before + 1);
    logger.log('dataset.test.event', { route: '/api/x' });
    expect(logger.droppedRecords()).toBe(before + 1);
  });

  it('keeps alert signals low-cardinality and strips tenant or raw response fields', () => {
    const signal = createAlertSignal('queue_backlog', {
      queue: 'training',
      count: 5,
      teamId: 'team-a',
      rawResponse: 'x',
    });
    expect(signal.fields).toEqual({ queue: 'training', count: 5 });
  });

  it('increments the global drop counter when the metrics port fails', () => {
    const before = metricDropCount();
    const result = recordMetric(
      {
        record: () => {
          throw new Error('metrics down');
        },
      },
      'dataset_queue_depth',
      1,
      { queue: 'q' },
    );
    expect(result).toEqual({ recorded: false });
    expect(metricDropCount()).toBe(before + 1);
  });
});
