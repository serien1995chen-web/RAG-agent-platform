import type { AuthSubject } from '@kb/service';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import type { AdminAuthResolver } from '../../runtime/admin-auth';
import { resolveAdminRequest } from '../../runtime/admin-auth';
import { readIdempotencyKey } from './idempotency';
import {
  withApiHandler,
  type ApiHandlerContext,
  type ApiRouteOptions,
  type ApiRouteHandler,
} from './with-api-handler';
import type { RequestContext } from '@kb/service';

export interface AdminRouteOptions extends ApiRouteOptions {
  resolver?: AdminAuthResolver;
}

export interface AdminHandlerContext extends ApiHandlerContext {
  subject: AuthSubject;
  context: RequestContext;
  idempotencyKey: string | null;
}

export type AdminRouteHandler = (
  request: NextApiRequest,
  response: NextApiResponse,
  context: AdminHandlerContext,
) => Promise<void> | void;

function stripIdempotencyHeader(request: NextApiRequest): NextApiRequest {
  const headers = { ...request.headers };
  delete headers['idempotency-key'];
  return { ...request, headers };
}

export function withAdminHandler(
  handler: AdminRouteHandler,
  options: AdminRouteOptions = {},
): NextApiHandler {
  return (request, response) => {
    const idempotencyKey = readIdempotencyKey(request);
    const adminRequest = stripIdempotencyHeader(request);
    const wrapped = withApiHandler(
      async (strippedRequest, innerResponse, context: ApiHandlerContext) => {
        const { getRuntime } = await import('../../runtime');
        const runtime = await getRuntime();
        const authenticated = options.resolver
          ? await options.resolver(runtime, request, context.requestId)
          : await resolveAdminRequest(runtime, request, context.requestId);
        await handler(strippedRequest, innerResponse, {
          ...context,
          subject: authenticated.subject,
          context: authenticated.context,
          idempotencyKey,
        });
      },
      {
        ...(options.validationErrorCode !== undefined
          ? { validationErrorCode: options.validationErrorCode }
          : {}),
        ...(options.maxRequestBodyBytes !== undefined
          ? { maxRequestBodyBytes: options.maxRequestBodyBytes }
          : {}),
      } satisfies ApiRouteOptions,
    ) as ApiRouteHandler;
    return wrapped(adminRequest, response);
  };
}
