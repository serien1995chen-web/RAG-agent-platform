import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiErrorException, createApiError } from '../../packages/contracts/src/index';

const teamId = '000000000000000000000001';
const runId = '0000000000000000000000aa';

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

function request(input: { url: string; body?: unknown; idempotencyKey?: string }): NextApiRequest {
  return {
    method: 'POST',
    url: input.url,
    query: {},
    body: input.body,
    headers: {
      'x-request-id': 'req-migration-e2e',
      ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
    },
  } as unknown as NextApiRequest;
}

function serviceError(code: number): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code,
      requestId: 'req-migration-e2e',
      params:
        code === 501024
          ? { migrationId: 'test-migration-v1', scope: { teamId } }
          : { cursor: 'cursor-1' },
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
              tmbId: '000000000000000000000002',
              authType: 'root',
              isRoot: true,
              sourceName: 'test-root',
            }
          : {
              teamId,
              tmbId: '000000000000000000000002',
              authType: 'token',
              isRoot: false,
              sourceName: 'test-user',
            },
    },
    migrationService: {
      dryRunMigration: vi.fn(async () => ({ report: { version: 'test-migration-v1' } })),
      applyMigration: vi.fn(async () => ({ runId })),
      resumeMigration: vi.fn(async () => ({ runId, cursor: 'cursor-2' })),
    },
  };
});

async function loadRoutes() {
  const [dryRun, apply, resume] = await Promise.all([
    import('../../projects/app/src/pages/api/admin/dataset/migrations/dry-run'),
    import('../../projects/app/src/pages/api/admin/dataset/migrations/apply'),
    import('../../projects/app/src/pages/api/admin/dataset/migrations/resume'),
  ]);
  return { dryRun: dryRun.default, apply: apply.default, resume: resume.default };
}

describe('Root migration routes (P7-04 / API-ROOT-001..003)', () => {
  it('rejects non-root callers with 501027 before service execution (ACC-OPS-002)', async () => {
    state.root = false;
    const { dryRun } = await loadRoutes();
    const rec = responseRecorder();
    await dryRun(
      request({
        url: '/api/admin/dataset/migrations/dry-run',
        body: { version: 'v1', scope: { teamIds: [teamId] } },
      }),
      rec.response,
    );
    const { status, body } = rec.result();
    expect(status).toBe(403);
    expect(body.code).toBe(501027);
  });

  it('returns dry-run output and never returns 501999 (ACC-MIG-001/006, ACC-OPS-001)', async () => {
    const { dryRun } = await loadRoutes();
    const rec = responseRecorder();
    await dryRun(
      request({
        url: '/api/admin/dataset/migrations/dry-run',
        body: { version: 'test-migration-v1', scope: { teamIds: [teamId] } },
      }),
      rec.response,
    );
    const { status, body } = rec.result();
    expect(status).toBe(200);
    expect(body.code).toBe(200);
    expect(body.data).toEqual({ report: { version: 'test-migration-v1' } });
    expect(body.code).not.toBe(501999);
  });

  it('requires an idempotency key for apply and returns the original run on replay (ACC-MIG-002)', async () => {
    const { apply } = await loadRoutes();
    const missing = responseRecorder();
    await apply(
      request({
        url: '/api/admin/dataset/migrations/apply',
        body: { version: 'test-migration-v1', scope: { teamIds: [teamId] } },
      }),
      missing.response,
    );
    expect(missing.result().status).toBe(400);
    expect(missing.result().body.code).toBe(501025);

    const first = responseRecorder();
    await apply(
      request({
        url: '/api/admin/dataset/migrations/apply',
        idempotencyKey: 'apply-1',
        body: { version: 'test-migration-v1', scope: { teamIds: [teamId] } },
      }),
      first.response,
    );
    const replay = responseRecorder();
    await apply(
      request({
        url: '/api/admin/dataset/migrations/apply',
        idempotencyKey: 'apply-1',
        body: { version: 'test-migration-v1', scope: { teamIds: [teamId] } },
      }),
      replay.response,
    );
    expect(first.result().body.data).toEqual({ runId });
    expect(replay.result().body.data).toEqual({ runId });
  });

  it('maps migration busy and invalid cursor errors without internal stacks (ACC-MIG-002/003)', async () => {
    const { apply, resume } = await loadRoutes();
    const runtime = state.runtime as {
      migrationService: {
        applyMigration: ReturnType<typeof vi.fn>;
        resumeMigration: ReturnType<typeof vi.fn>;
      };
    };
    runtime.migrationService.applyMigration.mockRejectedValueOnce(serviceError(501024));
    const busy = responseRecorder();
    await apply(
      request({
        url: '/api/admin/dataset/migrations/apply',
        idempotencyKey: 'apply-busy',
        body: { version: 'test-migration-v1', scope: { teamIds: [teamId] } },
      }),
      busy.response,
    );
    expect(busy.result().status).toBe(409);
    expect(busy.result().body.code).toBe(501024);
    expect(JSON.stringify(busy.result().body)).not.toMatch(/stack/i);

    runtime.migrationService.resumeMigration.mockRejectedValueOnce(serviceError(501025));
    const invalid = responseRecorder();
    await resume(
      request({
        url: '/api/admin/dataset/migrations/resume',
        idempotencyKey: 'resume-1',
        body: { runId, cursor: 'cursor-1' },
      }),
      invalid.response,
    );
    expect(invalid.result().status).toBe(400);
    expect(invalid.result().body.code).toBe(501025);
  });

  it('returns resume runId and cursor with the admin request context (ACC-MIG-003, ACC-DEPLOY-013)', async () => {
    const { resume } = await loadRoutes();
    const rec = responseRecorder();
    await resume(
      request({
        url: '/api/admin/dataset/migrations/resume',
        idempotencyKey: 'resume-2',
        body: { runId, cursor: 'cursor-1' },
      }),
      rec.response,
    );
    expect(rec.result().status).toBe(200);
    expect(rec.result().body.data).toEqual({ runId, cursor: 'cursor-2' });
  });
});
