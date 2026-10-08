import { createHash } from 'node:crypto';
import { ApiErrorException, createApiError, type ApiResponse } from '@kb/contracts';
import type { IdempotencyStore } from '@kb/dal';
import type { NextApiRequest } from 'next';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

export interface IdempotentResponse {
  status: number;
  body: unknown;
}

export interface ExecuteIdempotencyInput {
  store: IdempotencyStore;
  scopeKey: string;
  requestHash: string;
  requestId: string;
  execute: () => Promise<IdempotentResponse>;
}

/**
 * 协议级 409 冲突（设计文档 12.5；Plan 显式假设：不新增 501xxx 业务码、不改契约）。
 * 错误参数只携带 key 的哈希，绝不出现原文。
 */
export class IdempotencyConflictError extends Error {
  readonly keyHash: string;

  constructor(keyHash: string) {
    super('idempotency conflict');
    this.name = 'IdempotencyConflictError';
    this.keyHash = keyHash;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, sortValue(item)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

/** 递归按键排序的规范化 JSON（数组保持顺序）。 */
export function normalizeJson(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? 'null';
}

/** 请求体哈希：只输出 SHA-256，不记录原文。 */
export function bodyHashOf(body: unknown): string {
  return sha256(normalizeJson(body));
}

/** 幂等键哈希：日志与错误参数只允许出现该值。 */
export function keyHashOf(key: string): string {
  return sha256(key);
}

/** 读取 Idempotency-Key 头；非法或缺失返回 null（请求行为保持不变）。 */
export function readIdempotencyKey(request: NextApiRequest): string | null {
  const header = request.headers[IDEMPOTENCY_KEY_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  return trimmed;
}

/** 协议级 409 响应信封的唯一构造点（code=409、messageKey=common.conflict、errorType=conflict）。 */
export function buildConflictResponse(requestId: string, keyHash: string): ApiResponse<null> {
  return {
    code: 409,
    statusText: 'common.conflict',
    message: '相同幂等键的请求仍在处理中或请求体不一致',
    messageKey: 'common.conflict',
    params: { keyHash },
    data: null,
    errorType: 'conflict',
    retryable: 'no-retry',
    severity: 'warning',
    requestId,
  };
}

function idempotencyStoreError(requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501016,
      requestId,
      params: { store: 'redis', operation: 'idempotency' },
    }),
  );
}

/**
 * 请求级幂等执行器（设计文档 12.5）：
 * started → 执行业务并缓存 {status, body}；completed → 重放缓存；
 * processing/不同 bodyHash → 409；Redis 故障 → 501016（503，且不执行业务）。
 */
export async function executeWithIdempotency(
  input: ExecuteIdempotencyInput,
): Promise<IdempotentResponse> {
  let beginResult;
  try {
    beginResult = await input.store.begin(input.scopeKey, input.requestHash);
  } catch {
    throw idempotencyStoreError(input.requestId);
  }

  if (beginResult.kind === 'replay') {
    return beginResult.record.response as IdempotentResponse;
  }
  if (beginResult.kind === 'conflict') {
    throw new IdempotencyConflictError(keyHashOf(input.scopeKey));
  }

  let response: IdempotentResponse;
  try {
    response = await input.execute();
  } catch (error) {
    try {
      await input.store.fail(input.scopeKey);
    } catch {
      // 保留原始业务错误；清理失败不掩盖业务语义。
    }
    throw error;
  }

  try {
    await input.store.complete(input.scopeKey, response);
  } catch {
    throw idempotencyStoreError(input.requestId);
  }
  return response;
}
