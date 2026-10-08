import {
  ApiErrorException,
  createApiError,
  createInternalError,
  getErrorMeta,
  toApiResponse,
} from '@kb/contracts';
import { buildIdempotencyScopeKey, type IdempotencyStore } from '@kb/dal';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import {
  IdempotencyConflictError,
  bodyHashOf,
  buildConflictResponse,
  executeWithIdempotency,
  readIdempotencyKey,
} from './idempotency';
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
  /** Zod 入参错误映射到该路由在 12.4 矩阵中声明的 400 业务码。 */
  validationErrorCode?: number;
}

const IDEMPOTENT_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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

/** 统一 error → HTTP 响应映射；只允许通过本函数写错误响应。 */
function writeErrorResponse(
  status: StatusWriter,
  json: JsonWriter,
  requestId: string,
  operation: string,
  error: unknown,
  options: ApiRouteOptions,
): void {
  if (error instanceof ApiErrorException) {
    const meta = getErrorMeta(error.error.code);
    status(meta?.httpStatus ?? 500);
    json(toApiResponse(error.error));
    return;
  }
  if (isZodError(error) && options.validationErrorCode !== undefined) {
    const apiError = createApiError({
      code: options.validationErrorCode,
      requestId,
      zodError: error.issues,
    });
    const meta = getErrorMeta(options.validationErrorCode);
    status(meta?.httpStatus ?? 400);
    json(toApiResponse(apiError));
    return;
  }
  const internal = createInternalError(operation, requestId);
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

    const method = (request.method ?? 'GET').toUpperCase();
    const idempotencyKey = readIdempotencyKey(request);
    if (idempotencyKey === null || !IDEMPOTENT_METHODS.has(method)) {
      try {
        await handler(request, response, { requestId });
      } catch (error) {
        writeErrorResponse(rawStatus, rawJson, requestId, operation, error, options);
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
      writeErrorResponse(
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
      writeErrorResponse(rawStatus, rawJson, requestId, operation, error, options);
    }
  };
}
