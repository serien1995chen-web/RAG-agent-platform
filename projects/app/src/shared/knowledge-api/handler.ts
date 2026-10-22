import {
  KnowledgeApiError,
  createKnowledgeError,
  knowledgeErrorDefinition,
  matchRuntimeRoute,
  type RouteEntry,
} from '@kb/contracts';
import type { IdempotencyRecord } from '@kb/dal';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { bodyByteLength, requestHash } from './serialize';
import { requestPathname, resolveRequestIdentity } from './request-meta';
import type { KnowledgeApiRuntime, KnowledgeAuthSubject, KnowledgeDispatchResult } from './types';

const PUBLIC_OPERATIONS = new Set(['API-OPENAPI']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

function header(request: NextApiRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function normalizeScopes(subject: KnowledgeAuthSubject): Set<string> {
  return new Set(subject.scopes);
}

function firstWorkspaceId(subject: KnowledgeAuthSubject): string | null {
  return subject.workspaceIds[0] ?? null;
}

function publicErrorStatus(error: KnowledgeApiError): number {
  return knowledgeErrorDefinition(error.problem.error.code).status;
}

function writeProblem(
  response: NextApiResponse,
  error: KnowledgeApiError,
  requestId: string,
): void {
  response.setHeader('x-request-id', requestId);
  response.status(publicErrorStatus(error)).json(error.problem);
}

function internalError(
  requestId: string,
  traceId: string,
  details: Record<string, unknown> = {},
): KnowledgeApiError {
  return createKnowledgeError({
    code: 'KNOWLEDGE_INTERNAL_ERROR',
    requestId,
    traceId,
    details,
  });
}

function forbidden(requestId: string, traceId: string): KnowledgeApiError {
  return createKnowledgeError({
    code: 'KNOWLEDGE_FORBIDDEN',
    requestId,
    traceId,
  });
}

function notFound(requestId: string, traceId: string): KnowledgeApiError {
  return createKnowledgeError({
    code: 'KNOWLEDGE_NOT_FOUND',
    requestId,
    traceId,
  });
}

function validation(requestId: string, traceId: string, details: Record<string, unknown>) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_VALIDATION_FAILED',
    requestId,
    traceId,
    details,
  });
}

function conflict(requestId: string, traceId: string, details: Record<string, unknown>) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_CONFLICT',
    requestId,
    traceId,
    details,
  });
}

function resolveWorkspace(
  request: NextApiRequest,
  subject: KnowledgeAuthSubject,
  requestId: string,
  traceId: string,
): string {
  const workspaceId = header(request, 'x-workspace-id')?.trim();
  if (!workspaceId) throw forbidden(requestId, traceId);
  if (!subject.workspaceIds.includes(workspaceId)) {
    throw forbidden(requestId, traceId);
  }
  return workspaceId;
}

function assertScopes(
  route: RouteEntry,
  subject: KnowledgeAuthSubject,
  requestId: string,
  traceId: string,
): void {
  const granted = normalizeScopes(subject);
  for (const scope of route.scopes) {
    if (!granted.has(scope) && !granted.has('knowledge:admin')) {
      throw forbidden(requestId, traceId);
    }
  }
}

function validateIdempotencyHeader(
  request: NextApiRequest,
  requestId: string,
  traceId: string,
): string {
  const key = header(request, 'idempotency-key')?.trim();
  if (!key || key.length < 16 || key.length > 128) {
    throw validation(requestId, traceId, {
      header: 'Idempotency-Key',
      reason: 'required and must be 16-128 characters for this operation',
    });
  }
  return key;
}

async function withIdempotency(
  store: Awaited<ReturnType<KnowledgeApiRuntime['idempotencyStore']>>,
  scopeKey: string,
  hash: string,
  execute: () => Promise<KnowledgeDispatchResult>,
  requestId: string,
  traceId: string,
): Promise<KnowledgeDispatchResult> {
  const begun = await store.begin(scopeKey, hash);
  if (begun.kind === 'replay') {
    return begun.record.response as KnowledgeDispatchResult;
  }
  if (begun.kind === 'conflict') {
    const record = begun.record as IdempotencyRecord;
    throw conflict(requestId, traceId, {
      idempotency: record.state,
      requestHash: record.requestHash,
    });
  }
  try {
    const result = await execute();
    await store.complete(scopeKey, result);
    return result;
  } catch (error) {
    await store.fail(scopeKey).catch(() => undefined);
    throw error;
  }
}

async function loadRuntime(): Promise<KnowledgeApiRuntime> {
  const runtime = await import('../../runtime/knowledge-runtime');
  return runtime.getKnowledgeApiRuntime();
}

function cleanDetails(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    return { errorName: value.name };
  }
  return { errorType: typeof value };
}

export function createKnowledgeApiHandler(): NextApiHandler {
  return async (request: NextApiRequest, response: NextApiResponse): Promise<void> => {
    const { requestId, traceId } = resolveRequestIdentity(request);
    response.setHeader('x-request-id', requestId);
    response.setHeader('x-trace-id', traceId);
    const method = (request.method ?? 'GET').toUpperCase();
    const path = requestPathname(request);
    const match = matchRuntimeRoute(method, path);
    if (!match) {
      writeProblem(response, notFound(requestId, traceId), requestId);
      return;
    }
    const route = match.route;
    let runtime: KnowledgeApiRuntime;
    try {
      runtime = await loadRuntime();
    } catch {
      writeProblem(response, internalError(requestId, traceId, { stage: 'bootstrap' }), requestId);
      return;
    }

    try {
      if (bodyByteLength(request.body) > MAX_REQUEST_BODY_BYTES) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
          requestId,
          traceId,
        });
      }
      const isPublic = PUBLIC_OPERATIONS.has(route.operationId);
      const subject = isPublic
        ? {
            authType: 'jwt' as const,
            memberId: 'public',
            workspaceIds: [header(request, 'x-workspace-id') ?? 'public'],
            scopes: ['knowledge:read'],
          }
        : await runtime.authenticate(request, {
            workspaceId: header(request, 'x-workspace-id')?.trim() ?? null,
            requestId,
            traceId,
          });
      const workspaceId = isPublic
        ? (header(request, 'x-workspace-id') ?? firstWorkspaceId(subject) ?? 'public')
        : resolveWorkspace(request, subject, requestId, traceId);
      assertScopes(route, subject, requestId, traceId);

      const rateLimit = await runtime.rateLimit({ workspaceId, route, requestId });
      if (rateLimit) {
        response.setHeader('RateLimit-Limit', String(rateLimit.limit));
        response.setHeader('RateLimit-Remaining', String(Math.max(0, rateLimit.remaining)));
        response.setHeader('RateLimit-Reset', String(rateLimit.resetSeconds));
        if (!rateLimit.allowed) {
          response.setHeader('Retry-After', String(rateLimit.resetSeconds));
          throw createKnowledgeError({
            code: 'KNOWLEDGE_RATE_LIMITED',
            requestId,
            traceId,
          });
        }
      }

      const execute = () =>
        route.operationId === 'API-OPENAPI'
          ? import('@kb/contracts').then(({ OPENAPI_DOCUMENT }) => ({
              status: 200,
              data: OPENAPI_DOCUMENT,
            }))
          : runtime.dispatch({
              route,
              params: match.params,
              query: request.query,
              body: request.body,
              context: {
                subject,
                workspaceId,
                memberId: subject.memberId,
                scopes: subject.scopes,
                requestId,
                traceId,
              },
            });

      let result: KnowledgeDispatchResult;
      if (route.idempotent && WRITE_METHODS.has(method)) {
        const key = validateIdempotencyHeader(request, requestId, traceId);
        const store = await runtime.idempotencyStore();
        result = await withIdempotency(
          store,
          `kb-idem:${workspaceId}:${route.operationId}:${key}`,
          requestHash({ path, method, body: request.body ?? null }),
          execute,
          requestId,
          traceId,
        );
      } else {
        result = await execute();
      }

      for (const [name, value] of Object.entries(result.headers ?? {})) {
        response.setHeader(name, value);
      }
      if (result.status === 204) {
        response.status(204).end();
        runtime.log({
          event: 'knowledge.api.request.completed',
          requestId,
          traceId,
          operationId: route.operationId,
          details: { status: 204, workspaceId },
        });
        return;
      }
      response.status(result.status).json({
        success: true,
        data: result.data,
        traceId,
        requestId,
      });
      runtime.log({
        event: 'knowledge.api.request.completed',
        requestId,
        traceId,
        operationId: route.operationId,
        details: { status: result.status, workspaceId },
      });
    } catch (error) {
      if (error instanceof KnowledgeApiError) {
        writeProblem(response, error, requestId);
        return;
      }
      runtime?.log({
        event: 'knowledge.api.request.failed',
        requestId,
        traceId,
        operationId: route.operationId,
        details: cleanDetails(error),
      });
      writeProblem(
        response,
        internalError(requestId, traceId, { operationId: route.operationId }),
        requestId,
      );
    }
  };
}
