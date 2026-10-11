import { DEFAULT_DATASET_RUNTIME_CONFIG, type DatasetRuntimeConfig } from '../config/dataset-runtime-config.schema';

export const RAW_BODY_TOO_LARGE = 501030;
export const PAYLOAD_BYTES_EXCEEDED = 501065;

export interface RequestLimitConfig {
  /** 代理层原始字节上限（含压缩体）。 */
  maxRequestBodyBytes: number;
  /** 解压后字节上限；未单独配置时回落到代理字节上限。 */
  maxDecompressedBytes: number;
  /** 业务字段（JSON 序列化后）字节上限。 */
  maxBusinessBytes: number;
  /** 批量条目上限。 */
  maxItems: number;
}

export interface RequestLimitDecision {
  allowed: boolean;
  code?: number;
  layer?: 'proxy' | 'decompressed' | 'business' | 'items';
  limitBytes?: number;
  actualBytes?: number;
  limitItems?: number;
  actualItems?: number;
}

export function requestLimitsFromConfig(
  config: Pick<
    DatasetRuntimeConfig,
    'maxRequestBodyBytes' | 'maxRawTextBytes' | 'maxPushItems'
  > = DEFAULT_DATASET_RUNTIME_CONFIG,
): RequestLimitConfig {
  return {
    maxRequestBodyBytes: config.maxRequestBodyBytes,
    maxDecompressedBytes: config.maxRequestBodyBytes,
    maxBusinessBytes: config.maxRawTextBytes,
    maxItems: config.maxPushItems,
  };
}

export function checkProxyBytes(
  limits: RequestLimitConfig,
  contentLength: number | undefined,
): RequestLimitDecision {
  if (contentLength === undefined || !Number.isFinite(contentLength)) return { allowed: true };
  if (contentLength > limits.maxRequestBodyBytes) {
    return {
      allowed: false,
      code: RAW_BODY_TOO_LARGE,
      layer: 'proxy',
      limitBytes: limits.maxRequestBodyBytes,
      actualBytes: contentLength,
    };
  }
  return { allowed: true };
}

export function checkDecompressedBytes(
  limits: RequestLimitConfig,
  bytes: number,
): RequestLimitDecision {
  if (bytes > limits.maxDecompressedBytes) {
    return {
      allowed: false,
      code: RAW_BODY_TOO_LARGE,
      layer: 'decompressed',
      limitBytes: limits.maxDecompressedBytes,
      actualBytes: bytes,
    };
  }
  return { allowed: true };
}

export function checkBusinessBytes(
  limits: RequestLimitConfig,
  bytes: number,
): RequestLimitDecision {
  if (bytes > limits.maxBusinessBytes) {
    return {
      allowed: false,
      code: PAYLOAD_BYTES_EXCEEDED,
      layer: 'business',
      limitBytes: limits.maxBusinessBytes,
      actualBytes: bytes,
    };
  }
  return { allowed: true };
}

export function checkItemCount(
  limits: RequestLimitConfig,
  items: number,
): RequestLimitDecision {
  if (items > limits.maxItems) {
    return {
      allowed: false,
      code: RAW_BODY_TOO_LARGE,
      layer: 'items',
      limitItems: limits.maxItems,
      actualItems: items,
    };
  }
  return { allowed: true };
}

export function isLimitDecision(decision: RequestLimitDecision): decision is RequestLimitDecision & {
  allowed: false;
  code: number;
  layer: NonNullable<RequestLimitDecision['layer']>;
} {
  return !decision.allowed && decision.code !== undefined && decision.layer !== undefined;
}