import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import type { OtelConfig, OtelInitStatus } from './types';

/**
 * metrics 独立入口（设计文档 15.2）。
 * 业务只允许低基数标签；导出失败不得回滚业务。
 */
export function initMetrics(
  config: OtelConfig,
  readerFactory?: () => MetricReader,
): OtelInitStatus {
  if (!config.enabled || !config.exporterEndpointRef) {
    return { enabled: false, reason: 'exporter_not_configured' };
  }
  try {
    const reader = readerFactory
      ? readerFactory()
      : new PeriodicExportingMetricReader({ exporter: new ConsoleMetricExporter() });
    const provider = new MeterProvider({ readers: [reader] });
    provider.getMeter(config.serviceName);
    return { enabled: true, reason: 'registered' };
  } catch (error) {
    return {
      enabled: false,
      reason: `init_failed:${error instanceof Error ? error.name : 'unknown'}`,
    };
  }
}

/** 设计 15.7 / 6.1.6：OTLP metrics exporter 工厂（仅构造对象，不发起网络请求）。 */
export function createOtlpMetricExporter(endpointUrl: string): PushMetricExporter {
  return new OTLPMetricExporter({ url: endpointUrl });
}

/** 设计 15.7：OTLP 周期导出 reader 工厂（导出间隔由调用方保证 > 0）。 */
export function createOtlpMetricReader(
  endpointUrl: string,
  exportIntervalMillis: number,
): MetricReader {
  return new PeriodicExportingMetricReader({
    exporter: createOtlpMetricExporter(endpointUrl),
    exportIntervalMillis,
  });
}
