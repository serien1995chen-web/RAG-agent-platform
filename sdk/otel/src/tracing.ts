import { trace, type Tracer } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { OtelConfig, OtelInitStatus } from './types';

/**
 * trace 独立入口（设计文档 15.1 / 6.1.6）。
 * exporter 初始化失败不得影响业务：所有异常在入口内捕获并降级为 disabled。
 */
export function initTracing(
  config: OtelConfig,
  exporterFactory?: () => SpanExporter,
): OtelInitStatus {
  if (!config.enabled || !config.exporterEndpointRef) {
    return { enabled: false, reason: 'exporter_not_configured' };
  }
  try {
    const exporter = exporterFactory ? exporterFactory() : new ConsoleSpanExporter();
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ 'service.name': config.serviceName }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    provider.register();
    return { enabled: true, reason: 'registered' };
  } catch (error) {
    return {
      enabled: false,
      reason: `init_failed:${error instanceof Error ? error.name : 'unknown'}`,
    };
  }
}

export function getTracer(name = 'kb'): Tracer {
  return trace.getTracer(name);
}
