import { SpanStatusCode } from '@opentelemetry/api';
import type { LogRecordExporter } from '@opentelemetry/sdk-logs';
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { Writable } from 'node:stream';
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
  createNoopTelemetry,
  createSafeLogger,
  createTelemetryRuntime,
  emitAlert,
  initMetrics,
  initTracing,
  isSensitiveLogFields,
  sanitizeLogFields,
  setSpanStatusFromHttp,
  startInstrumentSpan,
} from '../../src/index';

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
    expect(() => logger.log('knowledge.test.event', { password: 'x' })).not.toThrow();
    expect(() =>
      logger.child({ module: 'test' }).log('knowledge.test.event', { ok: true }),
    ).not.toThrow();
  });

  it('drops unknown fields and value-level secrets while preserving safe fields', async () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createSafeLogger({
      name: 'test-capture',
      level: 'info',
      enabled: true,
      destination,
    });
    logger.log('knowledge.test.event', {
      requestId: 'request-safe',
      route: '/v1/knowledge/spaces',
      workspaceId: 'workspace-safe',
      body: 'must-not-leak',
      unknownField: 'must-not-leak-either',
    });
    logger.log('knowledge.test.event', {
      requestId: 'Bearer secret-value',
    });
    await new Promise((resolveWait) => setImmediate(resolveWait));

    expect(output).toContain('request-safe');
    expect(output).toContain('/v1/knowledge/spaces');
    expect(output).toContain('workspace-safe');
    expect(output).not.toContain('must-not-leak');
    expect(output).not.toContain('unknownField');
    expect(logger.droppedRecords()).toBe(3);
    expect(sanitizeLogFields({ requestId: 'r1', payload: 'x', route: '/ok' })).toEqual({
      fields: { requestId: 'r1', route: '/ok' },
      dropped: 1,
    });
  });

  it('creates no-op telemetry without endpoint and disposes idempotently', async () => {
    const telemetry = createNoopTelemetry();
    expect(telemetry.state().mode).toBe('noop');
    await expect(
      telemetry.withSpan('noop.span', { requestId: 'r1' }, async () => 'ok'),
    ).resolves.toBe('ok');
    await telemetry.dispose();
    await telemetry.dispose();
    expect(telemetry.droppedRecords()).toBe(0);
  });

  it('registers three OTLP entries and degrades each failed exporter independently', async () => {
    const endpoints: string[] = [];
    const traceExporter = new InMemorySpanExporter();
    const metricExporter = {
      export(_metrics: unknown, callback: (result: { code: number }) => void) {
        callback({ code: 0 });
      },
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    } as unknown as PushMetricExporter;
    const logExporter = {
      export(_records: unknown, callback: (result: { code: number }) => void) {
        callback({ code: 0 });
      },
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    } as unknown as LogRecordExporter;
    const telemetry = createTelemetryRuntime(
      {
        serviceName: 'kb-test',
        endpoint: 'http://127.0.0.1:4318',
        exportIntervalMillis: 60_000,
        logLevel: 'info',
      },
      {
        traceExporterFactory: (endpoint) => {
          endpoints.push(endpoint);
          return traceExporter;
        },
        metricExporterFactory: (endpoint) => {
          endpoints.push(endpoint);
          return metricExporter;
        },
        logExporterFactory: (endpoint) => {
          endpoints.push(endpoint);
          return logExporter;
        },
      },
    );
    expect(telemetry.state()).toMatchObject({
      mode: 'otlp',
      trace: { state: 'registered' },
      metrics: { state: 'registered' },
      logs: { state: 'registered' },
    });
    expect(endpoints.sort()).toEqual([
      'http://127.0.0.1:4318/v1/logs',
      'http://127.0.0.1:4318/v1/metrics',
      'http://127.0.0.1:4318/v1/traces',
    ]);
    telemetry.log('knowledge.test.safe', { requestId: 'request-safe' });
    await expect(
      telemetry.withSpan('test.span', { operation: 'test' }, async () => 'result'),
    ).resolves.toBe('result');
    await telemetry.dispose();
    await telemetry.dispose();

    const degraded = createTelemetryRuntime(
      {
        serviceName: 'kb-test',
        endpoint: 'http://127.0.0.1:4318',
        exportIntervalMillis: 60_000,
      },
      {
        traceExporterFactory: () => {
          throw new Error('trace exporter failed');
        },
        metricExporterFactory: () => metricExporter,
        logExporterFactory: () => logExporter,
      },
    );
    expect(degraded.state()).toMatchObject({
      mode: 'degraded',
      trace: { state: 'degraded' },
      metrics: { state: 'registered' },
      logs: { state: 'registered' },
    });
    await degraded.dispose();
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

  it('keeps the frozen 13-instrument dictionary', () => {
    expect(Object.keys(SPAN_INSTRUMENTS)).toHaveLength(13);
    expect(SPAN_INSTRUMENTS.http.allowedAttributes).toEqual([
      'route',
      'method',
      'status',
      'requestId',
    ]);
    expect(SPAN_INSTRUMENTS.search.allowedAttributes).toContain('searchMode');
    expect(SPAN_INSTRUMENTS.postgresql.forbiddenAttributes).toContain('向量原文');
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
    logger.log('knowledge.test.event', { rawResponse: 'x' });
    expect(logger.droppedRecords()).toBe(before + 1);
    logger.log('knowledge.test.event', { route: '/api/x' });
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
      workspaceId: 'ws-x',
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

  it('constructs OTLP exporter/reader factories without network I/O', async () => {
    expect(createOtlpTraceExporter('http://127.0.0.1:4318/v1/traces')).toBeDefined();
    expect(createOtlpMetricExporter('http://127.0.0.1:4318/v1/metrics')).toBeDefined();
    expect(createOtlpLogExporter('http://127.0.0.1:4318/v1/logs')).toBeDefined();
    const reader = createOtlpMetricReader('http://127.0.0.1:4318/v1/metrics', 60_000);
    expect(reader).toBeDefined();
    await reader.shutdown();
  });
});
