import {
  KnowledgeApiError,
  createKnowledgeError,
  knowledgeErrorDefinition,
  matchRuntimeRoute,
  type RouteEntry,
} from '@kb/contracts';
import { buildIdempotencyScopeKey, type IdempotencyRecord } from '@kb/dal';
import type { SafeAttributes, SafeLogFields } from '@kb/otel';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { bodyByteLength, requestHash } from './serialize';
import { requestPathname, resolveRequestIdentity } from './request-meta';
import type { KnowledgeApiRuntime, KnowledgeAuthSubject, KnowledgeDispatchResult } from './types';

const PUBLIC_OPERATIONS = new Set(['API-OPENAPI']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_PART_BYTES = 8 * 1024 * 1024;

type TelemetryKnowledgeApiRuntime = KnowledgeApiRuntime & {
  withSpan<T>(name: string, attributes: SafeAttributes, fn: () => Promise<T> | T): Promise<T>;
};

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

async function readStreamBody(
  request: NextApiRequest,
  maxBytes: number,
  requestId: string,
  traceId: string,
): Promise<Buffer | undefined> {
  if (request.body !== undefined) {
    if (request.body instanceof Uint8Array) return Buffer.from(request.body);
    if (typeof request.body === 'string') return Buffer.from(request.body);
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > maxBytes) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
        requestId,
        traceId,
        details: { limitBytes: maxBytes },
      });
    }
    chunks.push(buffer);
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

async function resolveRequestBody(
  request: NextApiRequest,
  rawBinary: boolean,
  requestId: string,
  traceId: string,
): Promise<unknown> {
  if (request.body !== undefined && !(request.body instanceof Uint8Array)) {
    return request.body;
  }
  if (request.body !== undefined && typeof request.body === 'string') {
    if (!rawBinary) return request.body;
  }
  const maxBytes = rawBinary ? MAX_UPLOAD_PART_BYTES : MAX_REQUEST_BODY_BYTES;
  const buffer = await readStreamBody(request, maxBytes, requestId, traceId);
  if (buffer === undefined) return undefined;
  if (rawBinary) return buffer;
  const contentType = header(request, 'content-type') ?? '';
  if (!contentType.toLowerCase().includes('json')) {
    throw validation(requestId, traceId, {
      header: 'Content-Type',
      reason: 'application_json_required',
    });
  }
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    throw validation(requestId, traceId, { field: 'body', reason: 'invalid_json' });
  }
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

async function loadRuntime(): Promise<TelemetryKnowledgeApiRuntime> {
  const runtime = await import('../../runtime/knowledge-runtime');
  return runtime.getKnowledgeApiRuntime();
}

function cleanDetails(value: unknown): SafeLogFields {
  if (value instanceof Error) {
    return { errorType: value.name };
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
    let runtime: TelemetryKnowledgeApiRuntime;
    try {
      runtime = await loadRuntime();
    } catch {
      writeProblem(response, internalError(requestId, traceId, { stage: 'bootstrap' }), requestId);
      return;
    }

    try {
      const requestBody = await resolveRequestBody(
        request,
        route.operationId === 'API-UPLOAD-PART',
        requestId,
        traceId,
      );
      const maxBodyBytes =
        route.operationId === 'API-UPLOAD-PART' ? MAX_UPLOAD_PART_BYTES : MAX_REQUEST_BODY_BYTES;
      if (bodyByteLength(requestBody) > maxBodyBytes) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
          requestId,
          traceId,
        });
      }
      const isPublic = PUBLIC_OPERATIONS.has(route.operationId);
      const ticketValue =
        route.operationId === 'API-FILE-CONTENT'
          ? Array.isArray(request.query.ticket)
            ? request.query.ticket[0]
            : request.query.ticket
          : undefined;
      const isTicketAuth = route.operationId === 'API-FILE-CONTENT' && Boolean(ticketValue);
      const skipAuthentication = isPublic || isTicketAuth;
      const subject = skipAuthentication
        ? {
            authType: 'jwt' as const,
            memberId: isTicketAuth ? 'file-ticket' : 'public',
            workspaceIds: [
              isTicketAuth ? 'ticket' : (header(request, 'x-workspace-id') ?? 'public'),
            ],
            scopes: ['knowledge:read'],
          }
        : await runtime.authenticate(request, {
            workspaceId: header(request, 'x-workspace-id')?.trim() ?? null,
            requestId,
            traceId,
          });
      const workspaceId = skipAuthentication
        ? isTicketAuth
          ? 'ticket'
          : (header(request, 'x-workspace-id') ?? firstWorkspaceId(subject) ?? 'public')
        : resolveWorkspace(request, subject, requestId, traceId);
      if (!isTicketAuth) assertScopes(route, subject, requestId, traceId);

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
        runtime.withSpan(
          `knowledge.api.${route.operationId}`,
          {
            route: route.path,
            method,
            requestId,
            operation: route.operationId,
          },
          () =>
            route.operationId === 'API-OPENAPI'
              ? import('@kb/contracts').then(({ OPENAPI_DOCUMENT }) => ({
                  status: 200,
                  data: OPENAPI_DOCUMENT,
                }))
              : runtime.dispatch({
                  route,
                  params: match.params,
                  query: request.query,
                  headers: request.headers as Record<string, string | string[] | undefined>,
                  body: requestBody,
                  context: {
                    subject,
                    workspaceId,
                    memberId: subject.memberId,
                    scopes: subject.scopes,
                    requestId,
                    traceId,
                  },
                }),
        );

      let result: KnowledgeDispatchResult;
      if (route.idempotent && WRITE_METHODS.has(method)) {
        const key = validateIdempotencyHeader(request, requestId, traceId);
        const store = await runtime.idempotencyStore();
        result = await withIdempotency(
          store,
          buildIdempotencyScopeKey(workspaceId, method, path, key),
          requestHash({ path, method, body: requestBody ?? null }),
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
          details: { httpStatus: 204, workspaceId },
        });
        return;
      }
      if (result.binary) {
        response.status(result.status);
        for await (const chunk of result.binary.body) {
          response.write(chunk);
        }
        response.end();
        runtime.log({
          event: 'knowledge.api.request.completed',
          requestId,
          traceId,
          operationId: route.operationId,
          details: { httpStatus: result.status, workspaceId },
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
        details: { httpStatus: result.status, workspaceId },
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
