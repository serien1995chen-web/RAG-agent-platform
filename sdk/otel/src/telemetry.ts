import {
  INVALID_SPAN_CONTEXT,
  SpanStatusCode,
  type Counter,
  type Exception,
  type Link,
  type Span,
  type SpanAttributeValue,
  type SpanAttributes,
  type SpanContext,
  type SpanStatus,
  type TimeInput,
  type Tracer,
} from '@opentelemetry/api';
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
import { createOtlpMetricExporter, METRIC_LABEL_ALLOWED_KEYS } from './metrics';
import { createOtlpTraceExporter, SPAN_ALLOWED_ATTRIBUTE_KEYS } from './tracing';
import {
  safeErrorAttributes,
  sanitizeTelemetryAttributes,
  sanitizeTelemetryEvent,
} from './redaction';
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

class LocalNonRecordingSpan implements Span {
  private readonly invalidContext: SpanContext = INVALID_SPAN_CONTEXT;

  spanContext(): SpanContext {
    return this.invalidContext;
  }

  setAttribute(_key: string, _value: SpanAttributeValue): this {
    return this;
  }

  setAttributes(_attributes: SpanAttributes): this {
    return this;
  }

  addEvent(_name: string, _attributes?: SpanAttributes): this {
    return this;
  }

  addLink(_link: Link): this {
    return this;
  }

  addLinks(_links: Link[]): this {
    return this;
  }

  setStatus(_status: SpanStatus): this {
    return this;
  }

  updateName(_name: string): this {
    return this;
  }

  end(_endTime?: TimeInput): void {}

  isRecording(): boolean {
    return false;
  }

  recordException(_exception: Exception, _time?: TimeInput): void {}
}

async function runWithNonRecordingSpan<T>(fn: (span: Span) => Promise<T> | T): Promise<T> {
  const span = new LocalNonRecordingSpan();
  try {
    return await fn(span);
  } finally {
    span.end();
  }
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
      return runWithNonRecordingSpan(fn);
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
  let tracer: Tracer | undefined;
  let traceProvider: NodeTracerProvider | undefined;
  let meterProvider: MeterProvider | undefined;
  let loggerProvider: LoggerProvider | undefined;
  let otelLogger: OtelLogger | undefined;
  let usageCounter: Counter | undefined;
  let dropped = 0;
  let disposePromise: Promise<void> | undefined;

  const degrade = (signal: 'trace' | 'metrics' | 'logs', error: unknown): void => {
    state[signal] = { state: 'degraded', reason: failureReason(error) };
    state.mode = 'degraded';
    dropped += 1;
  };

  const failedResult = () => ({ code: 1 }) as never;
  const isFailedResult = (result: unknown): boolean =>
    typeof result !== 'object' || result === null || !('code' in result) || result.code !== 0;

  const wrapSpanExporter = (exporter: SpanExporter): SpanExporter => {
    const wrapped = Object.create(exporter) as SpanExporter;
    wrapped.export = (spans, resultCallback) => {
      let settled = false;
      const finish = (result: Parameters<Parameters<SpanExporter['export']>[1]>[0]) => {
        if (settled) return;
        settled = true;
        if (isFailedResult(result)) degrade('trace', result);
        try {
          resultCallback(result);
        } catch (error) {
          degrade('trace', error);
        }
      };
      try {
        exporter.export(spans, finish);
      } catch (error) {
        degrade('trace', error);
        if (!settled) {
          settled = true;
          resultCallback(failedResult());
        }
      }
    };
    wrapped.forceFlush = async () => {
      try {
        await exporter.forceFlush?.();
      } catch (error) {
        degrade('trace', error);
        throw error;
      }
    };
    wrapped.shutdown = async () => {
      try {
        await exporter.shutdown();
      } catch (error) {
        degrade('trace', error);
        throw error;
      }
    };
    return wrapped;
  };

  const wrapMetricExporter = (exporter: PushMetricExporter): PushMetricExporter => {
    const wrapped = Object.create(exporter) as PushMetricExporter;
    wrapped.export = (metrics, resultCallback) => {
      let settled = false;
      const finish = (result: Parameters<Parameters<PushMetricExporter['export']>[1]>[0]) => {
        if (settled) return;
        settled = true;
        if (isFailedResult(result)) degrade('metrics', result);
        try {
          resultCallback(result);
        } catch (error) {
          degrade('metrics', error);
        }
      };
      try {
        exporter.export(metrics, finish);
      } catch (error) {
        degrade('metrics', error);
        if (!settled) {
          settled = true;
          resultCallback(failedResult());
        }
      }
    };
    wrapped.forceFlush = async () => {
      try {
        await exporter.forceFlush?.();
      } catch (error) {
        degrade('metrics', error);
        throw error;
      }
    };
    wrapped.shutdown = async () => {
      try {
        await exporter.shutdown();
      } catch (error) {
        degrade('metrics', error);
        throw error;
      }
    };
    return wrapped;
  };

  const wrapLogExporter = (exporter: LogRecordExporter): LogRecordExporter => {
    type MaybeFlushLogExporter = LogRecordExporter & {
      forceFlush?: () => Promise<void>;
    };
    const wrapped = Object.create(exporter) as MaybeFlushLogExporter;
    wrapped.export = (records, resultCallback) => {
      let settled = false;
      const finish = (result: Parameters<Parameters<LogRecordExporter['export']>[1]>[0]) => {
        if (settled) return;
        settled = true;
        if (isFailedResult(result)) degrade('logs', result);
        try {
          resultCallback(result);
        } catch (error) {
          degrade('logs', error);
        }
      };
      try {
        exporter.export(records, finish);
      } catch (error) {
        degrade('logs', error);
        if (!settled) {
          settled = true;
          resultCallback(failedResult());
        }
      }
    };
    if (typeof (exporter as MaybeFlushLogExporter).forceFlush === 'function') {
      wrapped.forceFlush = async () => {
        try {
          await (exporter as MaybeFlushLogExporter).forceFlush?.();
        } catch (error) {
          degrade('logs', error);
          throw error;
        }
      };
    }
    wrapped.shutdown = async () => {
      try {
        await exporter.shutdown();
      } catch (error) {
        degrade('logs', error);
        throw error;
      }
    };
    return wrapped;
  };

  try {
    const traceExporter = wrapSpanExporter(
      (dependencies.traceExporterFactory ?? createOtlpTraceExporter)(
        signalEndpoint(config.endpoint, 'traces'),
      ),
    );
    traceProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(traceExporter)],
    });
    tracer = traceProvider.getTracer(config.serviceName);
    state.trace = { state: 'registered', reason: 'registered' };
  } catch (error) {
    degrade('trace', error);
  }

  try {
    const metricExporter = wrapMetricExporter(
      (dependencies.metricExporterFactory ?? createOtlpMetricExporter)(
        signalEndpoint(config.endpoint, 'metrics'),
      ),
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
    degrade('metrics', error);
  }

  try {
    const logExporter = wrapLogExporter(
      (dependencies.logExporterFactory ?? createOtlpLogExporter)(
        signalEndpoint(config.endpoint, 'logs'),
      ),
    );
    loggerProvider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor(logExporter)],
    });
    otelLogger = loggerProvider.getLogger(config.serviceName);
    state.logs = { state: 'registered', reason: 'registered' };
  } catch (error) {
    degrade('logs', error);
  }

  if (
    state.trace.state === 'registered' &&
    state.metrics.state === 'registered' &&
    state.logs.state === 'registered'
  ) {
    state.mode = 'otlp';
  }

  return {
    async withSpan(name, attributes, fn) {
      let callbackStarted = false;
      const sanitized = sanitizeTelemetryAttributes(attributes, SPAN_ALLOWED_ATTRIBUTE_KEYS);
      dropped += sanitized.dropped;
      if (!tracer) return runWithNonRecordingSpan(fn);
      try {
        return await tracer.startActiveSpan(
          name,
          { attributes: sanitized.attributes },
          async (span) => {
            callbackStarted = true;
            try {
              return await fn(span);
            } catch (error) {
              try {
                span.addEvent('exception', safeErrorAttributes(error));
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
          },
        );
      } catch (error) {
        if (!callbackStarted) {
          dropped += 1;
          return runWithNonRecordingSpan(fn);
        }
        throw error;
      }
    },
    recordUsage(event) {
      try {
        const sanitized = sanitizeTelemetryAttributes(event.attributes, METRIC_LABEL_ALLOWED_KEYS);
        dropped += sanitized.dropped;
        usageCounter?.add(Math.max(0, event.value ?? 1), sanitized.attributes);
      } catch (error) {
        degrade('metrics', error);
      }
    },
    log(event, fields) {
      try {
        const sanitized = sanitizeLogFields(fields);
        dropped += sanitized.dropped;
        const sanitizedEvent = sanitizeTelemetryEvent(event);
        dropped += sanitizedEvent.dropped;
        safeLogger.log(sanitizedEvent.event, sanitized.fields);
        otelLogger?.emit({
          severityNumber: SeverityNumber.INFO,
          severityText: 'INFO',
          body: sanitizedEvent.event,
          attributes: sanitized.fields,
        });
      } catch (error) {
        degrade('logs', error);
      }
    },
    droppedRecords: () => dropped + safeLogger.droppedRecords(),
    async dispose() {
      disposePromise ??= (async () => {
        await Promise.allSettled([
          (async () => {
            try {
              await traceProvider?.forceFlush();
            } catch (error) {
              if (state.trace.state !== 'degraded') degrade('trace', error);
            }
            try {
              await traceProvider?.shutdown();
            } catch (error) {
              if (state.trace.state !== 'degraded') degrade('trace', error);
            }
          })(),
          (async () => {
            try {
              await meterProvider?.forceFlush();
            } catch (error) {
              if (state.metrics.state !== 'degraded') degrade('metrics', error);
            }
            try {
              await meterProvider?.shutdown();
            } catch (error) {
              if (state.metrics.state !== 'degraded') degrade('metrics', error);
            }
          })(),
          (async () => {
            try {
              await loggerProvider?.forceFlush();
            } catch (error) {
              if (state.logs.state !== 'degraded') degrade('logs', error);
            }
            try {
              await loggerProvider?.shutdown();
            } catch (error) {
              if (state.logs.state !== 'degraded') degrade('logs', error);
            }
          })(),
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
