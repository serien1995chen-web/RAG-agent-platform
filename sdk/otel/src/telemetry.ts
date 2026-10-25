import { SpanStatusCode, trace, type Counter, type Span, type Tracer } from '@opentelemetry/api';
import { SeverityNumber, type Logger as OtelLogger } from '@opentelemetry/api-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
} from '@opentelemetry/sdk-logs';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { createOtlpLogExporter, createSafeLogger, sanitizeLogFields } from './logger';
import { createOtlpMetricExporter } from './metrics';
import { createOtlpTraceExporter } from './tracing';
import type { LogLevel, SafeAttributes, SafeLogFields, TelemetryState } from './types';

export interface TelemetryContext {
  requestId: string;
  traceId: string;
  workspaceId?: string;
  operation?: string;
}

export interface SafeUsageEvent {
  name: string;
  value?: number;
  attributes?: SafeAttributes;
}

export interface TelemetryConfig {
  serviceName: string;
  endpoint?: string;
  exportIntervalMillis?: number;
  enabled?: boolean;
  logLevel?: LogLevel;
}

export interface TelemetryRuntime {
  withSpan<T>(
    name: string,
    attributes: SafeAttributes,
    fn: (span: Span) => Promise<T> | T,
  ): Promise<T>;
  recordUsage(event: SafeUsageEvent): void;
  log(event: string, fields: SafeLogFields): void;
  droppedRecords(): number;
  dispose(): Promise<void>;
  state(): TelemetryState;
}

export interface TelemetryDependencies {
  traceExporterFactory?: (endpoint: string) => SpanExporter;
  metricExporterFactory?: (endpoint: string) => PushMetricExporter;
  logExporterFactory?: (endpoint: string) => LogRecordExporter;
}

const DEFAULT_EXPORT_INTERVAL_MS = 60_000;

function signalEndpoint(endpoint: string, signal: 'traces' | 'metrics' | 'logs'): string {
  const url = new URL(endpoint);
  if (url.pathname === '/' || url.pathname === '') {
    url.pathname = `/v1/${signal}`;
  }
  return url.toString();
}

function failureReason(error: unknown): string {
  return `degraded:${error instanceof Error ? error.name : 'unknown'}`;
}

export function createNoopTelemetry(): TelemetryRuntime {
  const state: TelemetryState = {
    mode: 'noop',
    trace: { state: 'disabled', reason: 'exporter_not_configured' },
    metrics: { state: 'disabled', reason: 'exporter_not_configured' },
    logs: { state: 'disabled', reason: 'exporter_not_configured' },
  };
  let disposed = false;
  return {
    async withSpan(_name, _attributes, fn) {
      const span = trace.getTracer('knowledge-noop').startSpan('knowledge.noop');
      try {
        return await fn(span);
      } finally {
        span.end();
      }
    },
    recordUsage() {},
    log() {},
    droppedRecords: () => 0,
    async dispose() {
      disposed = true;
    },
    state: () => ({ ...state, mode: disposed ? 'noop' : state.mode }),
  };
}

export function createTelemetryRuntime(
  config: TelemetryConfig,
  dependencies: TelemetryDependencies = {},
): TelemetryRuntime {
  if (config.enabled === false || !config.endpoint) return createNoopTelemetry();

  const state: TelemetryState = {
    mode: 'degraded',
    trace: { state: 'disabled', reason: 'not_initialized' },
    metrics: { state: 'disabled', reason: 'not_initialized' },
    logs: { state: 'disabled', reason: 'not_initialized' },
  };
  const resource = resourceFromAttributes({ 'service.name': config.serviceName });
  const safeLogger = createSafeLogger({
    name: config.serviceName,
    level: config.logLevel ?? 'info',
    enabled: true,
  });
  let tracer: Tracer = trace.getTracer('knowledge-noop');
  let traceProvider: NodeTracerProvider | undefined;
  let meterProvider: MeterProvider | undefined;
  let loggerProvider: LoggerProvider | undefined;
  let otelLogger: OtelLogger | undefined;
  let usageCounter: Counter | undefined;
  let dropped = 0;
  let disposePromise: Promise<void> | undefined;

  try {
    const traceExporter = (dependencies.traceExporterFactory ?? createOtlpTraceExporter)(
      signalEndpoint(config.endpoint, 'traces'),
    );
    traceProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(traceExporter)],
    });
    tracer = traceProvider.getTracer(config.serviceName);
    state.trace = { state: 'registered', reason: 'registered' };
  } catch (error) {
    state.trace = { state: 'degraded', reason: failureReason(error) };
  }

  try {
    const metricExporter = (dependencies.metricExporterFactory ?? createOtlpMetricExporter)(
      signalEndpoint(config.endpoint, 'metrics'),
    );
    const exportIntervalMillis = Math.max(
      1_000,
      config.exportIntervalMillis ?? DEFAULT_EXPORT_INTERVAL_MS,
    );
    const reader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis,
    });
    meterProvider = new MeterProvider({ resource, readers: [reader] });
    usageCounter = meterProvider
      .getMeter(config.serviceName)
      .createCounter('knowledge.usage.events');
    state.metrics = { state: 'registered', reason: 'registered' };
  } catch (error) {
    state.metrics = { state: 'degraded', reason: failureReason(error) };
  }

  try {
    const logExporter = (dependencies.logExporterFactory ?? createOtlpLogExporter)(
      signalEndpoint(config.endpoint, 'logs'),
    );
    loggerProvider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor(logExporter)],
    });
    otelLogger = loggerProvider.getLogger(config.serviceName);
    state.logs = { state: 'registered', reason: 'registered' };
  } catch (error) {
    state.logs = { state: 'degraded', reason: failureReason(error) };
  }

  state.mode =
    state.trace.state === 'registered' &&
    state.metrics.state === 'registered' &&
    state.logs.state === 'registered'
      ? 'otlp'
      : 'degraded';

  return {
    async withSpan(name, attributes, fn) {
      let callbackStarted = false;
      try {
        return await tracer.startActiveSpan(name, { attributes }, async (span) => {
          callbackStarted = true;
          try {
            return await fn(span);
          } catch (error) {
            try {
              span.recordException(error instanceof Error ? error : String(error));
              span.setStatus({ code: SpanStatusCode.ERROR });
            } catch {
              dropped += 1;
            }
            throw error;
          } finally {
            try {
              span.end();
            } catch {
              dropped += 1;
            }
          }
        });
      } catch (error) {
        if (!callbackStarted) {
          dropped += 1;
          const fallbackSpan = trace.getTracer('knowledge-noop').startSpan('knowledge.noop');
          try {
            return await fn(fallbackSpan);
          } finally {
            fallbackSpan.end();
          }
        }
        throw error;
      }
    },
    recordUsage(event) {
      try {
        usageCounter?.add(Math.max(0, event.value ?? 1), event.attributes);
      } catch {
        // Metrics must never affect business behavior.
      }
    },
    log(event, fields) {
      try {
        const sanitized = sanitizeLogFields(fields);
        dropped += sanitized.dropped;
        safeLogger.log(event, sanitized.fields);
        otelLogger?.emit({
          severityNumber: SeverityNumber.INFO,
          severityText: 'INFO',
          body: event,
          attributes: sanitized.fields,
        });
      } catch {
        dropped += 1;
      }
    },
    droppedRecords: () => dropped + safeLogger.droppedRecords(),
    async dispose() {
      disposePromise ??= (async () => {
        await Promise.allSettled([
          traceProvider?.shutdown() ?? Promise.resolve(),
          meterProvider?.shutdown() ?? Promise.resolve(),
          loggerProvider?.shutdown() ?? Promise.resolve(),
        ]);
      })();
      await disposePromise;
    },
    state: () => ({ ...state }),
  };
}

let configuredTelemetry: TelemetryRuntime | undefined;

export function configureTelemetry(config: TelemetryConfig): TelemetryRuntime {
  configuredTelemetry ??= createTelemetryRuntime(config);
  return configuredTelemetry;
}
