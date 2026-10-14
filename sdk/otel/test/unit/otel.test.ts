import { SpanStatusCode } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ALERT_KINDS,
  LOG_FIELD_DICTIONARY,
  SPAN_INSTRUMENTS,
  createAlertSignal,
  createOtlpLogExporter,
  createOtlpMetricExporter,
  createOtlpMetricReader,
  createOtlpTraceExporter,
  createSafeLogger,
  emitAlert,
  initMetrics,
  initTracing,
  isSensitiveLogFields,
  setSpanStatusFromHttp,
  startInstrumentSpan,
} from '../../src/index';
import {
  INSTRUMENT_CLASSES,
  METRIC_DEFINITIONS,
  METRIC_NAMES,
  metricDropCount,
  recordMetric,
} from '../../../../packages/service/src/shared/observability/instruments';

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

describe('P7-03 OTel metrics / span / log / alert contracts (15.1-15.5)', () => {
  const exporter = new InMemorySpanExporter();

  beforeAll(() => {
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  it('keeps the frozen 43-metric and 13-instrument dictionaries', () => {
    expect(METRIC_DEFINITIONS).toHaveLength(43);
    expect(METRIC_NAMES).toEqual(METRIC_DEFINITIONS.map((entry) => entry.name));
    expect(new Set(METRIC_NAMES).size).toBe(43);
    expect(Object.keys(SPAN_INSTRUMENTS)).toHaveLength(13);
    expect(INSTRUMENT_CLASSES).toHaveLength(13);
    expect(new Set(INSTRUMENT_CLASSES).size).toBe(13);

    expect(SPAN_INSTRUMENTS.http.allowedAttributes).toEqual([
      'route',
      'method',
      'status',
      'requestId',
    ]);
    expect(SPAN_INSTRUMENTS.search.allowedAttributes).toContain('searchMode');
    expect(SPAN_INSTRUMENTS.postgresql.forbiddenAttributes).toContain('向量原文');
    expect(METRIC_DEFINITIONS.every((entry) => !entry.allowedAttributes.includes('teamId'))).toBe(
      true,
    );
  });

  it('filters attributes to the instrument whitelist and ends the span', async () => {
    exporter.reset();
    const result = await startInstrumentSpan(
      'http',
      'http.request',
      { route: '/api/x', method: 'GET', leaked: 'nope' },
      async () => 'ok',
      { httpStatus: 404 },
    );
    expect(result).toBe('ok');
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes).toMatchObject({ route: '/api/x', method: 'GET' });
    expect(spans[0]?.attributes).not.toHaveProperty('leaked');
    expect(spans[0]?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('marks 5xx and thrown errors as span errors and rethrows business errors', async () => {
    exporter.reset();
    await startInstrumentSpan('search', 'search.query', { searchMode: 'mix' }, async () => 1, {
      httpStatus: 503,
    });
    expect(exporter.getFinishedSpans()[0]?.status.code).toBe(SpanStatusCode.ERROR);

    exporter.reset();
    await expect(
      startInstrumentSpan('qa', 'qa.answer', { model: 'x' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const failed = exporter.getFinishedSpans();
    expect(failed).toHaveLength(1);
    expect(failed[0]?.status.code).toBe(SpanStatusCode.ERROR);

    const fake = { setStatus: (s: unknown) => s, recordException: (e: unknown) => e };
    setSpanStatusFromHttp(fake as never, 400);
  });

  it('counts dropped log records and extends the sensitive field set', () => {
    const logger = createSafeLogger({ name: 'p7', level: 'info', enabled: true });
    const before = logger.droppedRecords();
    logger.log('dataset.test.event', { rawResponse: 'x' });
    expect(logger.droppedRecords()).toBe(before + 1);
    logger.log('dataset.test.event', { route: '/api/x' });
    expect(logger.droppedRecords()).toBe(before + 1);
    expect(LOG_FIELD_DICTIONARY).toHaveLength(13);
    expect(LOG_FIELD_DICTIONARY).toContain('retryCount');
    expect(createSafeLogger({ name: 'n', level: 'info', enabled: false }).droppedRecords()).toBe(0);
  });

  it('sanitizes alert signals and never lets the sink block business', async () => {
    expect(ALERT_KINDS).toHaveLength(7);
    const signal = createAlertSignal('queue_backlog', {
      queue: 'training',
      count: 5,
      teamId: 'team-x',
      rawResponse: 'x',
    });
    expect(signal.kind).toBe('queue_backlog');
    expect(signal.fields).toEqual({ queue: 'training', count: 5 });
    expect(await emitAlert(signal, undefined)).toBe(false);
    expect(
      await emitAlert(signal, {
        emit: async () => {
          throw new Error('sink down');
        },
      }),
    ).toBe(false);
    expect(await emitAlert(signal, { emit: async () => undefined })).toBe(true);
  });

  it('records whitelisted metrics through the entry without throwing', () => {
    const calls: Array<{ name: string; attributes: Record<string, string> }> = [];
    const port = {
      record: (name: string, _value: number, attributes: Record<string, string>) => {
        calls.push({ name, attributes });
      },
    };
    expect(
      recordMetric(port, 'dataset_http_requests_total', 1, { method: 'GET', route: '/x' }),
    ).toEqual({ recorded: true });
    expect(
      recordMetric(port, 'dataset_http_requests_total', 1, { route: '/x', leaked: 'y' }),
    ).toEqual({ recorded: true, dropped: 'attribute_not_allowed' });
    expect(calls[1]?.attributes).toEqual({ route: '/x' });
    expect(recordMetric(port, 'nope_metric', 1, {})).toEqual({
      recorded: false,
      dropped: 'unknown_metric',
    });

    const before = metricDropCount();
    const boom = {
      record: () => {
        throw new Error('metrics down');
      },
    };
    expect(recordMetric(boom, 'dataset_queue_depth', 1, { queue: 'q' })).toEqual({
      recorded: false,
    });
    expect(metricDropCount()).toBe(before + 1);
  });

  it('constructs OTLP exporter/reader factories without network I/O', async () => {
    expect(createOtlpTraceExporter('http://127.0.0.1:4318/v1/traces')).toBeDefined();
    expect(createOtlpMetricExporter('http://127.0.0.1:4318/v1/metrics')).toBeDefined();
    expect(createOtlpLogExporter('http://127.0.0.1:4318/v1/logs')).toBeDefined();
    const reader = createOtlpMetricReader('http://127.0.0.1:4318/v1/metrics', 60_000);
    expect(reader).toBeDefined();
    await reader.shutdown();
  });
});
