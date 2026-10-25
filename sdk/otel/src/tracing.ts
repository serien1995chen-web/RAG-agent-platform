import { SpanStatusCode, trace, type Span, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type {
  OtelConfig,
  OtelInitStatus,
  SpanInstrumentDefinition,
  SpanInstrumentName,
} from './types';

export type { SpanInstrumentDefinition, SpanInstrumentName } from './types';

/** 设计 15.1 附录 B：13 类 Instrument 的低基数白名单与显式禁止属性。 */
export const SPAN_INSTRUMENTS: Record<SpanInstrumentName, SpanInstrumentDefinition> = {
  http: {
    name: 'http',
    allowedAttributes: ['route', 'method', 'status', 'requestId'],
    forbiddenAttributes: ['凭证', '完整 Query', '文件正文'],
  },
  mongodb: {
    name: 'mongodb',
    allowedAttributes: ['operation', 'collection', 'result'],
    forbiddenAttributes: ['完整 BSON', '文档正文'],
  },
  redis: {
    name: 'redis',
    allowedAttributes: ['command', 'queue', 'result'],
    forbiddenAttributes: ['幂等结果', 'Token'],
  },
  postgresql: {
    name: 'postgresql',
    allowedAttributes: ['operation', 'rows', 'latency'],
    forbiddenAttributes: ['向量原文', '完整向量'],
  },
  s3: {
    name: 's3',
    allowedAttributes: ['operation', 'bucketType', 'result'],
    forbiddenAttributes: ['签名 URL', 'object content'],
  },
  parse: {
    name: 'parse',
    allowedAttributes: ['mode', 'provider', 'pageCount'],
    forbiddenAttributes: ['文件正文', 'Provider 响应'],
  },
  qa: {
    name: 'qa',
    allowedAttributes: ['model', 'tokens', 'result'],
    forbiddenAttributes: ['Prompt 全文'],
  },
  vector: {
    name: 'vector',
    allowedAttributes: ['model', 'batchSize', 'dimension'],
    forbiddenAttributes: ['向量原文'],
  },
  delete: {
    name: 'delete',
    allowedAttributes: ['stage', 'resourceType', 'result'],
    forbiddenAttributes: ['失败资源正文'],
  },
  sync: {
    name: 'sync',
    allowedAttributes: ['knowledgeSpaceId', 'mode', 'result'],
    forbiddenAttributes: ['外部凭证'],
  },
  search: {
    name: 'search',
    allowedAttributes: ['searchMode', 'recallPaths', 'degraded'],
    forbiddenAttributes: ['Query 全文', '命中正文'],
  },
  migration: {
    name: 'migration',
    allowedAttributes: ['version', 'batch', 'cursor', 'state'],
    forbiddenAttributes: ['客户数据样本正文'],
  },
  reconcile: {
    name: 'reconcile',
    allowedAttributes: ['window', 'scope', 'findingKind'],
    forbiddenAttributes: ['完整报告正文'],
  },
};

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
    const exporter = exporterFactory
      ? exporterFactory()
      : createOtlpTraceExporter(config.exporterEndpointRef);
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

/** 设计 15.7 / 6.1.6：OTLP trace exporter 工厂（仅构造对象，不发起网络请求）。 */
export function createOtlpTraceExporter(endpointUrl: string): SpanExporter {
  return new OTLPTraceExporter({ url: endpointUrl });
}

/**
 * 设计 15.1：4xx 业务错误不设 Span error；5xx 与内部异常才标记错误。
 */
export function setSpanStatusFromHttp(span: Span, httpStatus: number): void {
  if (httpStatus >= 500) {
    span.recordException(`http_status_${httpStatus}`);
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
}

/**
 * 设计 15.1：统一 Span helper（低基数白名单属性；span 始终 end()；
 * 追踪层自身异常不得外泄，业务异常照常向上传播）。
 */
export async function startInstrumentSpan<T>(
  instrument: SpanInstrumentName,
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T> | T,
  options: { httpStatus?: number } = {},
): Promise<T> {
  const tracer = trace.getTracer('kb');
  const allowed = SPAN_INSTRUMENTS[instrument].allowedAttributes;
  const filtered: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (allowed.includes(key)) filtered[key] = value;
  }
  return tracer.startActiveSpan(name, { attributes: filtered }, async (span) => {
    try {
      const result = await fn(span);
      if (options.httpStatus !== undefined) {
        setSpanStatusFromHttp(span, options.httpStatus);
      }
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
