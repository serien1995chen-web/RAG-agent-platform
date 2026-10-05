import {
  ApiErrorException,
  createApiError,
  createInternalError,
  getErrorMeta,
  toApiResponse,
} from '@kb/contracts';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
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

function isZodError(error: unknown): error is { issues: unknown } {
  return error instanceof Error && error.name === 'ZodError';
}

/** 统一 requestId、错误映射与 x-request-id 响应头；路由内不得自行拼装错误结构。 */
export function withApiHandler(
  handler: ApiRouteHandler,
  options: ApiRouteOptions = {},
): NextApiHandler {
  return async (request, response) => {
    const requestId = resolveRequestId(request);
    response.setHeader('x-request-id', requestId);
    try {
      await handler(request, response, { requestId });
    } catch (error) {
      if (error instanceof ApiErrorException) {
        const meta = getErrorMeta(error.error.code);
        response.status(meta?.httpStatus ?? 500).json(toApiResponse(error.error));
        return;
      }
      if (isZodError(error) && options.validationErrorCode !== undefined) {
        const apiError = createApiError({
          code: options.validationErrorCode,
          requestId,
          zodError: error.issues,
        });
        const meta = getErrorMeta(options.validationErrorCode);
        response.status(meta?.httpStatus ?? 400).json(toApiResponse(apiError));
        return;
      }
      const internal = createInternalError(request.url ?? 'unknown', requestId);
      response.status(500).json(toApiResponse(internal));
    }
  };
}
