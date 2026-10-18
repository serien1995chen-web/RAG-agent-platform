import {
  ApiErrorException,
  createApiError,
  createInternalError,
  getErrorMeta,
  toApiResponse,
} from '@kb/contracts';
import { buildIdempotencyScopeKey, type IdempotencyStore } from '@kb/dal';
import { DEFAULT_DATASET_RUNTIME_CONFIG, type DatasetRuntimeConfig } from '@kb/service';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import {
  assertContentLength,
  assertDecodedBody,
} from '../../../../../packages/service/src/shared/http/limits';
import { getAppConfig } from '../../runtime/config';
import {
  IdempotencyConflictError,
  bodyHashOf,
  buildConflictResponse,
  executeWithIdempotency,
  readIdempotencyKey,
} from './idempotency';
import { describeInternalError, newErrorEventId } from './internal-error-log';
import { resolveRequestId } from './request-id';

export interface ApiHandlerContext {
  requestId: string;
}

export type ApiRouteHandler = (
  request: NextApiRequest,
  response: NextApiResponse,
  context: ApiHandlerContext,
) => Promise<void> | void;

export interface ApiRouteOptions {
  /**
   * Zod 入参错误映射到该路由在 12.4 矩阵中声明的业务码。
   * ISSUE-006：需要按 issue 区分语义时（如维度不匹配 vs 普通缺参）可传解析函数。
   */
  validationErrorCode?: number | ((issues: unknown) => number);
  /** 路由级原始/解码 body 上限覆盖（如 import 允许 20MB）；缺省用配置 maxRequestBodyBytes。 */
  maxRequestBodyBytes?: number;
}

const IDEMPOTENT_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 第一/二层请求上限由配置注入；配置不可用时回落到冻结默认值（失败关闭，绝不静默放行）。 */
function resolveRequestLimits(): DatasetRuntimeConfig {
  try {
    return getAppConfig().datasetRuntime;
  } catch {
    return DEFAULT_DATASET_RUNTIME_CONFIG;
  }
}

type StatusWriter = (code: number) => NextApiResponse;
type JsonWriter = (body: unknown) => NextApiResponse;

function isZodError(error: unknown): error is { issues: unknown } {
  return error instanceof Error && error.name === 'ZodError';
}

function idempotencyUnavailable(requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501016,
      requestId,
      params: { store: 'redis', operation: 'idempotency' },
    }),
  );
}

/**
 * ISSUE-007：未知内部错误落结构化日志。日志失败绝不影响响应
 * （logger 自身也是 no-op 降级），且不输出完整错误对象与请求上下文。
 */
async function logInternalError(
  error: unknown,
  requestId: string,
  operation: string,
  errorEventId: string,
): Promise<void> {
  try {
    const { getRuntime } = await import('../../runtime/health');
    const runtime = await getRuntime();
    const summary = describeInternalError(error);
    runtime.clients.logger.log('api.internal_error', {
      requestId,
      operation,
      errorEventId,
      httpStatus: 500,
      errorCode: 501998,
      errorType: 'internal',
      errorName: summary.errorName,
      detail: summary.detail,
      stackHead: summary.stackHead,
    });
  } catch {
    // 观测失败不阻塞业务响应。
  }
}

/** 统一 error → HTTP 响应映射；只允许通过本函数写错误响应。 */
async function writeErrorResponse(
  status: StatusWriter,
  json: JsonWriter,
  requestId: string,
  operation: string,
  error: unknown,
  options: ApiRouteOptions,
): Promise<void> {
  if (error instanceof ApiErrorException) {
    const meta = getErrorMeta(error.error.code);
    status(meta?.httpStatus ?? 500);
    json(toApiResponse(error.error));
    return;
  }
  if (isZodError(error) && options.validationErrorCode !== undefined) {
    const resolvedCode =
      typeof options.validationErrorCode === 'function'
        ? options.validationErrorCode(error.issues)
        : options.validationErrorCode;
    const apiError = createApiError({
      code: resolvedCode,
      requestId,
      zodError: error.issues,
    });
    const meta = getErrorMeta(resolvedCode);
    status(meta?.httpStatus ?? 400);
    json(toApiResponse(apiError));
    return;
  }
  const errorEventId = newErrorEventId();
  const internal = createInternalError(operation, requestId);
  internal.params = { ...internal.params, errorEventId };
  await logInternalError(error, requestId, operation, errorEventId);
  status(500);
  json(toApiResponse(internal));
}

/** 懒加载 runtime 并解析认证主体；teamId 只能来自认证主体，不接受请求体/头声明。 */
async function resolveIdempotencyContext(
  request: NextApiRequest,
  requestId: string,
): Promise<{ store: IdempotencyStore; teamId: string }> {
  const { getRuntime } = await import('../../runtime/health');
  const { authenticateRequest } = await import('../../runtime/auth');
  const runtime = await getRuntime();
  const { subject } = await authenticateRequest(runtime, request, requestId);
  const store = runtime.clients.idempotencyStore;
  if (!store) throw idempotencyUnavailable(requestId);
  return { store, teamId: subject.teamId };
}

/** 统一 requestId、错误映射与 x-request-id 响应头；写方法带 Idempotency-Key 时启用请求级幂等。 */
export function withApiHandler(
  handler: ApiRouteHandler,
  options: ApiRouteOptions = {},
): NextApiHandler {
  return async (request, response) => {
    const requestId = resolveRequestId(request);
    response.setHeader('x-request-id', requestId);
    const rawStatus = response.status.bind(response) as StatusWriter;
    const rawJson = response.json.bind(response) as JsonWriter;
    const operation = request.url ?? 'unknown';

    const limits = resolveRequestLimits();
    const bodyLimit = options.maxRequestBodyBytes ?? limits.maxRequestBodyBytes;
    try {
      assertContentLength({
        headers: request.headers,
        limitBytes: bodyLimit,
        requestId,
      });
      assertDecodedBody({
        body: request.body,
        limitBytes: bodyLimit,
        requestId,
      });
    } catch (error) {
      await writeErrorResponse(rawStatus, rawJson, requestId, operation, error, options);
      return;
    }

    const method = (request.method ?? 'GET').toUpperCase();
    const idempotencyKey = readIdempotencyKey(request);
    if (idempotencyKey === null || !IDEMPOTENT_METHODS.has(method)) {
      try {
        await handler(request, response, { requestId });
      } catch (error) {
        await writeErrorResponse(rawStatus, rawJson, requestId, operation, error, options);
      }
      return;
    }

    let capturedStatus = 200;
    let capturedBody: unknown = null;
    response.status = ((code: number) => {
      capturedStatus = code;
      return response;
    }) as typeof response.status;
    response.json = ((body: unknown) => {
      capturedBody = body;
      return response;
    }) as typeof response.json;

    let idempotencyContext: { store: IdempotencyStore; teamId: string };
    try {
      idempotencyContext = await resolveIdempotencyContext(request, requestId);
    } catch {
      await writeErrorResponse(
        rawStatus,
        rawJson,
        requestId,
        operation,
        idempotencyUnavailable(requestId),
        options,
      );
      return;
    }

    try {
      const result = await executeWithIdempotency({
        store: idempotencyContext.store,
        scopeKey: buildIdempotencyScopeKey(
          idempotencyContext.teamId,
          method,
          request.url ?? '',
          idempotencyKey,
        ),
        requestHash: bodyHashOf(request.body ?? null),
        requestId,
        execute: async () => {
          await handler(request, response, { requestId });
          return { status: capturedStatus, body: capturedBody };
        },
      });
      rawStatus(result.status);
      rawJson(result.body);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        rawStatus(409);
        rawJson(buildConflictResponse(requestId, error.keyHash));
        return;
      }
      await writeErrorResponse(rawStatus, rawJson, requestId, operation, error, options);
    }
  };
}
