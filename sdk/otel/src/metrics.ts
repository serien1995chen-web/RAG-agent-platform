import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
} from '@opentelemetry/sdk-metrics';
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
