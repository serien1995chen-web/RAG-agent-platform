import { MemoryIdempotencyStore, type IdempotencyStore } from '@kb/dal';
import { createKnowledgeError, type HealthResponse, type RouteEntry } from '@kb/contracts';
import type { KnowledgeApiRuntime, KnowledgeDispatchResult } from '../shared/knowledge-api/types';

const idempotencyStore = new MemoryIdempotencyStore();

/**
 * The contract layer boots with a fail-closed runtime. The application
 * composition replaces this provider with infrastructure-backed ports before
 * accepting baseline traffic.
 */
const runtime: KnowledgeApiRuntime = {
  async authenticate(request, input) {
    const authorization = request.headers.authorization;
    const token = Array.isArray(authorization) ? authorization[0] : authorization;
    if (!token?.startsWith('Bearer ') || !input.workspaceId) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_AUTH_REQUIRED',
        requestId: input.requestId,
        traceId: input.traceId,
      });
    }
    throw createKnowledgeError({
      code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
      requestId: input.requestId,
      traceId: input.traceId,
      details: { provider: 'IAM', status: 'EXTERNAL_UNVERIFIED' },
    });
  },
  async idempotencyStore(): Promise<IdempotencyStore> {
    return idempotencyStore;
  },
  async rateLimit() {
    return null;
  },
  async readiness(_requestId): Promise<{ status: number; body: HealthResponse }> {
    return {
      status: 503,
      body: {
        status: 'down',
        checks: [
          { name: 'mongo', status: 'down', latencyMs: 0 },
          { name: 'redis', status: 'down', latencyMs: 0 },
          { name: 'postgres', status: 'down', latencyMs: 0 },
          { name: 's3', status: 'down', latencyMs: 0 },
          { name: 'iam', status: 'down', latencyMs: 0 },
          { name: 'telemetry', status: 'noop', latencyMs: 0 },
        ],
        timestamp: new Date().toISOString(),
      },
    };
  },
  async dispatch(input): Promise<KnowledgeDispatchResult> {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
      requestId: input.context.requestId,
      traceId: input.context.traceId,
      details: { operationId: input.route.operationId, stage: 'runtime-composition' },
    });
  },
  log(input) {
    const safe = JSON.stringify({
      event: input.event,
      requestId: input.requestId,
      traceId: input.traceId,
      operationId: input.operationId,
      details: input.details ?? {},
    });
    process.stderr.write(`${safe}\n`);
  },
};

export function getKnowledgeApiRuntime(): KnowledgeApiRuntime {
  return runtime;
}

export function runtimeOperationIdsForTest(routes: readonly RouteEntry[]): string[] {
  return routes.map((route) => route.operationId);
}
