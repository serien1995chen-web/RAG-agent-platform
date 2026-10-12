import { ApiErrorException, createApiError } from '@kb/contracts';

export interface RequestLimitConfig {
  maxRequestBodyBytes: number;
  maxRawTextBytes: number;
  maxPushItems: number;
}

function sizeExceeded(
  requestId: string,
  limitBytes: number,
  actualBytes: number,
): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501065,
      requestId,
      params: { limitBytes, actualBytes, urlHash: '' },
    }),
  );
}

/** JSON 序列化后的 UTF-8 字节数；null/undefined 视为 0。 */
export function jsonByteLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** 第一层：代理原始 Content-Length 上限（超限 501065，不读 body）。 */
export function assertContentLength(input: {
  headers: Record<string, string | string[] | undefined>;
  limitBytes: number;
  requestId: string;
}): void {
  const raw = input.headers['content-length'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return;
  const actual = Number(value);
  if (!Number.isFinite(actual) || actual < 0) return;
  if (actual > input.limitBytes) {
    throw sizeExceeded(input.requestId, input.limitBytes, actual);
  }
}

/** 第二层：解码后 body 字节上限（超限 501065，handler 不执行）。 */
export function assertDecodedBody(input: {
  body: unknown;
  limitBytes: number;
  requestId: string;
}): void {
  const actual = jsonByteLength(input.body);
  if (actual > input.limitBytes) {
    throw sizeExceeded(input.requestId, input.limitBytes, actual);
  }
}

/** 第三层：业务字段字节上限（调用方已计算 bytes）。 */
export function assertBusinessBytes(input: {
  bytes: number;
  limitBytes: number;
  requestId: string;
}): void {
  if (input.bytes > input.limitBytes) {
    throw sizeExceeded(input.requestId, input.limitBytes, input.bytes);
  }
}

/** pushData 业务层：先条数（501030）再字节（501065），均在副作用前。 */
export function assertPushDataBusinessLimits(input: {
  items: number;
  bytes: number;
  maxItems: number;
  maxBytes: number;
  requestId: string;
}): void {
  if (input.items > input.maxItems) {
    throw new ApiErrorException(
      createApiError({
        code: 501030,
        requestId: input.requestId,
        params: { limit: input.maxItems, actual: input.items },
      }),
    );
  }
  if (input.bytes > input.maxBytes) {
    throw sizeExceeded(input.requestId, input.maxBytes, input.bytes);
  }
}

/** rawText 上限：超限 501065，不得产生对象残留。 */
export function assertRawTextBytes(input: {
  bytes: number;
  limitBytes: number;
  requestId: string;
}): void {
  if (input.bytes > input.limitBytes) {
    throw sizeExceeded(input.requestId, input.limitBytes, input.bytes);
  }
}
