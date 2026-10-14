import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiErrorException, createApiError } from '../../packages/contracts/src/index';

const teamId = '000000000000000000000001';
const tmbId = '000000000000000000000002';

const state = vi.hoisted(() => ({
  runtime: undefined as unknown,
  root: true,
}));

vi.mock('../../projects/app/src/runtime', () => ({
  getRuntime: async () => state.runtime,
}));

function responseRecorder(): {
  response: NextApiResponse;
  result: () => { status: number; body: { code?: number; data?: unknown; params?: unknown } };
} {
  let status = 200;
  let body: unknown;
  const response = {
    setHeader: () => response,
    status(code: number) {
      status = code;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    },
  } as unknown as NextApiResponse;
  return {
    response,
    result: () => ({ status, body: body as { code?: number; data?: unknown; params?: unknown } }),
  };
}

function request(input: {
  method?: string;
  url: string;
  query?: Record<string, unknown>;
}): NextApiRequest {
  return {
    method: input.method ?? 'GET',
    url: input.url,
    query: input.query ?? {},
    body: undefined,
    headers: { 'x-request-id': 'req-admin-security' },
  } as unknown as NextApiRequest;
}

function crossTenantError(): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501070,
      requestId: 'req-admin-security',
      params: { resourceType: 'dataset', resourceId: '0000000000000000000000bb' },
    }),
  );
}

beforeEach(() => {
  state.root = true;
  state.runtime = {
    adminAuthProvider: {
      resolve: async () =>
        state.root
          ? {
              teamId,
              tmbId,
              authType: 'root',
              isRoot: true,
              sourceName: 'test-root',
            }
          : {
              teamId,
              tmbId,
              authType: 'token',
              isRoot: false,
              sourceName: 'test-user',
            },
    },
    extensions: { get: () => null },
    health: {
      checkRequired: vi.fn(async () => [
        { name: 'mongo', status: 'ok', durationMs: 1 },
      ]),
      checkOptional: vi.fn(async () => []),
      summarize: vi.fn(() => ({
        httpStatus: 200,
        response: { status: 'ok', checks: [{ name: 'mongo', status: 'ok', durationMs: 1 }], durationMs: 1 },
      })),
    },
    config: {
      system: { instanceId: 'kb-1' },
      role: { mode: 'all', runsHttp: true },
    },
    startup: { state: 'ready', issues: [] },
    startedAt: 123,
    reconcileService: {
      listReports: vi.fn(async () => ({ total: 0, list: [] })),
    },
    ports: {
      audit: { append: vi.fn(async () => ({ auditId: 'audit-1' })) },
    },
  };
});

async function loadCatchAll() {
  return (await import('../../projects/app/src/pages/api/admin/dataset/[...path]')).default;
}

async function loadReports() {
  return (await import('../../projects/app/src/pages/api/admin/dataset/reconcile/reports')).default;
}

describe('Root Admin security boundary (P7-05 / ACC-OPS-002 / ACC-ACL-007 / ACC-SEC-001)', () => {
  it('returns 501027 for non-root subjects without leaking internals (TEST-TEN-API-001)', async () => {
    state.root = false;
    const handler = await loadCatchAll();
    const rec = responseRecorder();
    await handler(
      request({
        url: '/api/admin/dataset/health',
        query: { path: ['health'] },
      }),
      rec.response,
    );
    const { status, body } = rec.result();
    expect(status).toBe(403);
    expect(body.code).toBe(501027);
    expect(body.params).toEqual({ requiredRole: 'root' });
    expect(JSON.stringify(body)).not.toMatch(/stack|token|secret/i);
  });

  it('serves sanitized health and system information while extensions are disabled', async () => {
    const handler = await loadCatchAll();
    const health = responseRecorder();
    await handler(
      request({
        url: '/api/admin/dataset/health',
        query: { path: ['health'] },
      }),
      health.response,
    );
    expect(health.result().status).toBe(200);
    expect(health.result().body.data).toEqual({
      status: 'ok',
      checks: [{ name: 'mongo', status: 'ok', durationMs: 1 }],
      durationMs: 1,
    });
    expect(JSON.stringify(health.result().body)).not.toMatch(/connection|secret|password/i);

    const system = responseRecorder();
    await handler(
      request({
        url: '/api/admin/dataset/system',
        query: { path: ['system'] },
      }),
      system.response,
    );
    expect(system.result().status).toBe(200);
    expect(system.result().body.data).toEqual({
      instanceId: 'kb-1',
      role: { mode: 'all', runsHttp: true },
      startup: { state: 'ready', issues: [] },
      startedAt: 123,
    });
  });

  it('routes the P6 reconcile report through the Admin handler (ACC-OPS-002, TEST-API-MASK-001)', async () => {
    const handler = await loadReports();
    const rec = responseRecorder();
    await handler(
      request({
        url: '/api/admin/dataset/reconcile/reports?window=6h',
        query: {
          window: '6h',
          scope: JSON.stringify({ teamIds: [teamId] }),
        },
      }),
      rec.response,
    );
    expect(rec.result().status).toBe(200);
    expect(rec.result().body.data).toEqual({ total: 0, list: [] });
    const runtime = state.runtime as {
      reconcileService: { listReports: ReturnType<typeof vi.fn> };
      ports: { audit: { append: ReturnType<typeof vi.fn> } };
    };
    expect(runtime.reconcileService.listReports).toHaveBeenCalledWith(
      expect.objectContaining({ windowHours: 6, page: 1 }),
      expect.objectContaining({ tenant: expect.objectContaining({ teamId }) }),
    );
    expect(runtime.ports.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          operator: tmbId,
          requestId: 'req-admin-security',
          result: 'success',
        }),
      }),
      expect.any(Object),
    );
  });

  it('rejects cross-tenant admin reads with 501070, audits failure, and hides tenant details', async () => {
    const runtime = state.runtime as {
      reconcileService: { listReports: ReturnType<typeof vi.fn> };
      ports: { audit: { append: ReturnType<typeof vi.fn> } };
    };
    runtime.reconcileService.listReports.mockRejectedValueOnce(crossTenantError());
    const handler = await loadReports();
    const rec = responseRecorder();
    await handler(
      request({
        url: '/api/admin/dataset/reconcile/reports?window=6h',
        query: {
          window: '6h',
          scope: JSON.stringify({ teamIds: ['0000000000000000000000bb'] }),
        },
      }),
      rec.response,
    );
    const { status, body } = rec.result();
    expect(status).toBe(404);
    expect(body.code).toBe(501070);
    expect(JSON.stringify(body)).not.toMatch(/team-b|stack|secret|connection/i);
    expect(runtime.ports.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ result: 'failure', requestId: 'req-admin-security' }),
      }),
      expect.any(Object),
    );
  });

  it('returns 501070 for non-whitelisted catch-all paths instead of 501999', async () => {
    const handler = await loadCatchAll();
    const rec = responseRecorder();
    await handler(
      request({
        url: '/api/admin/dataset/unknown',
        query: { path: ['unknown'] },
      }),
      rec.response,
    );
    expect(rec.result().status).toBe(404);
    expect(rec.result().body.code).toBe(501070);
  });
});
