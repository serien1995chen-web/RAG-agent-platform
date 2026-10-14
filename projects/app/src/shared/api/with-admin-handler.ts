import type { AuditPort, AuthSubject, RequestContext } from '@kb/service';
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

function bodyRecord(request: NextApiRequest): Record<string, unknown> {
  return typeof request.body === 'object' && request.body !== null
    ? (request.body as Record<string, unknown>)
    : {};
}

async function auditAdminRequest(input: {
  runtime: unknown;
  request: NextApiRequest;
  requestId: string;
  authenticated?: { subject: AuthSubject; context: RequestContext };
  result: 'success' | 'failure';
}): Promise<void> {
  const audit = (input.runtime as { ports?: { audit?: AuditPort } }).ports?.audit;
  if (!audit || !input.authenticated) return;
  const body = bodyRecord(input.request);
  const dryRun = (input.request.url ?? '').includes('/migrations/dry-run');
  try {
    await audit.append(
      {
        eventId: `admin.request:${input.requestId}:${input.result}`,
        teamId: input.authenticated.context.tenant.teamId,
        actorTmbId: input.authenticated.context.tenant.tmbId,
        resourceType: 'admin',
        resourceId: input.request.url ?? 'unknown',
        operation: dryRun ? 'admin.migration.dry-run' : 'admin.request',
        requestId: input.requestId,
        payload: {
          operator: input.authenticated.subject.uid ?? input.authenticated.subject.tmbId,
          scope: body.scope ?? null,
          version: body.version ?? null,
          dryRun,
          result: input.result,
          requestId: input.requestId,
        },
      },
      input.authenticated.context,
    );
  } catch {
    // Admin audit is best-effort; the admin response must not be replaced by an audit-store error.
  }
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
        let authenticated: Awaited<ReturnType<AdminAuthResolver>> | undefined;
        try {
          authenticated = options.resolver
            ? await options.resolver(runtime, request, context.requestId)
            : await resolveAdminRequest(runtime, request, context.requestId);
          await handler(strippedRequest, innerResponse, {
            ...context,
            subject: authenticated.subject,
            context: authenticated.context,
            idempotencyKey,
          });
          await auditAdminRequest({
            runtime,
            request,
            requestId: context.requestId,
            authenticated,
            result: 'success',
          });
        } catch (error) {
          await auditAdminRequest({
            runtime,
            request,
            requestId: context.requestId,
            ...(authenticated !== undefined ? { authenticated } : {}),
            result: 'failure',
          });
          throw error;
        }
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
