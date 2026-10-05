export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface OtelConfig {
  serviceName: string;
  enabled: boolean;
  exporterEndpointRef?: string;
  logLevel: LogLevel;
}

export interface OtelInitStatus {
  enabled: boolean;
  reason: string;
}
