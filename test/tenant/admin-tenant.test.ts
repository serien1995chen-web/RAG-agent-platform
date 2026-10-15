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
  result: () => { status: number; body: { code?: number; params?: unknown; data?: unknown } };
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
    result: () => ({ status, body: body as { code?: number; params?: unknown; data?: unknown } }),
  };
}

function request(scopeTeamId: string): NextApiRequest {
  return {
    method: 'GET',
    url: '/api/admin/dataset/reconcile/reports?window=6h',
    body: undefined,
    query: {
      window: '6h',
      scope: JSON.stringify({ teamIds: [scopeTeamId] }),
    },
    headers: { 'x-request-id': 'req-admin-tenant' },
  } as unknown as NextApiRequest;
}

function crossTenantError(): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501070,
      requestId: 'req-admin-tenant',
      params: { resourceType: 'team', resourceId: '0000000000000000000000bb' },
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
    reconcileService: {
      listReports: vi.fn(async () => ({ total: 0, list: [] })),
    },
    ports: {
      audit: { append: vi.fn(async () => ({ auditId: 'audit-1' })) },
    },
  };
});

async function loadReports() {
  return (await import('../../projects/app/src/pages/api/admin/dataset/reconcile/reports')).default;
}

describe('P7-07 admin tenant isolation (TEST-TEN-API-001 / TEST-API-MASK-001)', () => {
  it('rejects unauthorized callers with 501027', async () => {
    state.root = false;
    const handler = await loadReports();
    const rec = responseRecorder();
    await handler(request(teamId), rec.response);
    expect(rec.result().status).toBe(403);
    expect(rec.result().body.code).toBe(501027);
  });

  it('rejects cross-tenant reads with 501070 and writes failure audit', async () => {
    const runtime = state.runtime as {
      reconcileService: { listReports: ReturnType<typeof vi.fn> };
      ports: { audit: { append: ReturnType<typeof vi.fn> } };
    };
    runtime.reconcileService.listReports.mockRejectedValueOnce(crossTenantError());
    const handler = await loadReports();
    const rec = responseRecorder();
    await handler(request('0000000000000000000000bb'), rec.response);
    expect(rec.result().status).toBe(404);
    expect(rec.result().body.code).toBe(501070);
    expect(runtime.ports.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          operator: tmbId,
          result: 'failure',
          requestId: 'req-admin-tenant',
        }),
      }),
      expect.any(Object),
    );
  });

  it('never exposes stacks, secrets, or cross-tenant resource details', async () => {
    const runtime = state.runtime as {
      reconcileService: { listReports: ReturnType<typeof vi.fn> };
    };
    runtime.reconcileService.listReports.mockRejectedValueOnce(crossTenantError());
    const handler = await loadReports();
    const rec = responseRecorder();
    await handler(request('0000000000000000000000bb'), rec.response);
    const serialized = JSON.stringify(rec.result().body);
    expect(serialized).not.toMatch(/stack|secret|connection|team-b|password/i);
  });
});
