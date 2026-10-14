import { ApiErrorException, createApiError } from '../../packages/contracts/src/index';
import { MemoryIdempotencyStore } from '../../packages/dal/src/index';
import type { RequestContext } from '../../packages/service/src/ports/types';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import collectionDeleteRoute from '../../projects/app/src/pages/api/core/dataset/collection/delete';
import dataDeleteRoute from '../../projects/app/src/pages/api/core/dataset/data/delete';
import datasetDeleteRoute from '../../projects/app/src/pages/api/core/dataset/delete';
import jobRoute from '../../projects/app/src/pages/api/core/dataset/delete-jobs/[jobId]';
import failuresRoute from '../../projects/app/src/pages/api/core/dataset/delete-jobs/[jobId]/failures';
import retryRoute from '../../projects/app/src/pages/api/core/dataset/delete-jobs/[jobId]/retry';

const context: RequestContext = {
  requestId: 'req-delete-jobs',
  tenant: {
    teamId: '000000000000000000000001',
    tmbId: '000000000000000000000002',
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const datasetId = '000000000000000000000101';
const collectionId = '000000000000000000000102';
const dataId = '000000000000000000000103';
const jobId = 'opaque-job-id';

const state = vi.hoisted(() => ({
  runtime: undefined as unknown,
}));

vi.mock('../../projects/app/src/runtime', () => ({
  getRuntime: async () => state.runtime,
}));
vi.mock('../../projects/app/src/runtime/health', () => ({
  getRuntime: async () => state.runtime,
}));
vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context, subject: context.tenant }),
}));

function responseRecorder(): {
  response: NextApiResponse;
  result: () => { status: number; body: unknown };
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
  return { response, result: () => ({ status, body }) };
}

function request(input: {
  method: string;
  url: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
}): NextApiRequest {
  return {
    method: input.method,
    url: input.url,
    query: input.query ?? {},
    body: input.body,
    headers: input.headers ?? {},
  } as unknown as NextApiRequest;
}

function buildRuntime(options: { permissionMask?: number; missingJob?: boolean } = {}) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const retryJob = vi.fn(async () => {
    throw new Error('worker retryJob must not be called');
  });
  const runtime = {
    clients: { idempotencyStore: new MemoryIdempotencyStore() },
    datasetPermission: {
      async getPermission() {
        return {
          owner: context.tenant.tmbId,
          permissionMask: options.permissionMask ?? 8,
          inherited: true,
          version: 1,
          source: 'local',
        };
      },
    },
    collectionRepository: {
      async get() {
        return { collectionId, datasetId };
      },
    },
    knowledgeItemRepository: {
      async get() {
        return { dataId, datasetId, collectionId };
      },
    },
    deleteService: {
      async requestDatasetDelete(input: unknown) {
        calls.push({ method: 'requestDatasetDelete', input });
        return { jobId, state: 'queued' };
      },
      async requestCollectionDelete(input: unknown) {
        calls.push({ method: 'requestCollectionDelete', input });
        return { jobId, state: 'queued' };
      },
      async requestDataDelete(input: unknown) {
        calls.push({ method: 'requestDataDelete', input });
        return { jobId, state: 'queued' };
      },
      async getDeleteJob(input: unknown) {
        calls.push({ method: 'getDeleteJob', input });
        if (options.missingJob) {
          throw new ApiErrorException(
            createApiError({
              code: 501070,
              requestId: context.requestId,
              params: { resourceType: 'job', resourceId: jobId },
            }),
          );
        }
        return {
          jobId,
          teamId: context.tenant.teamId,
          datasetId,
          state: 'failed',
          stage: 'vector',
          progress: 40,
          failureCount: 1,
          createTime: '2026-10-14T00:00:00.000Z',
          updateTime: '2026-10-14T00:00:00.000Z',
        };
      },
      async listFailures(input: { limit: number }) {
        calls.push({ method: 'listFailures', input });
        return {
          total: 1,
          list: [
            {
              resourceType: 'vector',
              resourceId: 'internal-vector-key',
              reason: `s3-key=${'x'.repeat(200)}`,
            },
          ],
          cursor: 'cursor-1',
        };
      },
      async retryDeleteJob(input: unknown) {
        calls.push({ method: 'retryDeleteJob', input });
        return { jobId, state: 'queued' };
      },
      retryJob,
    },
  };
  return { runtime, calls, retryJob };
}

beforeEach(() => {
  state.runtime = buildRuntime().runtime;
});

describe('P6-05 lifecycle delete routes', () => {
  it('ACC-DELETE-001 keeps dataset delete idempotent and Owner-only', async () => {
    const built = buildRuntime();
    state.runtime = built.runtime;
    const first = responseRecorder();
    await datasetDeleteRoute(
      request({
        method: 'POST',
        url: '/api/core/dataset/delete',
        headers: { 'idempotency-key': 'dataset-del-1' },
        body: { datasetId },
      }),
      first.response,
    );
    const second = responseRecorder();
    await datasetDeleteRoute(
      request({
        method: 'POST',
        url: '/api/core/dataset/delete',
        headers: { 'idempotency-key': 'dataset-del-2' },
        body: { datasetId },
      }),
      second.response,
    );
    expect((first.result().body as { data: { jobId: string } }).data.jobId).toBe(jobId);
    expect((second.result().body as { data: { jobId: string } }).data.jobId).toBe(jobId);

    const deniedRuntime = buildRuntime({ permissionMask: 2 });
    state.runtime = deniedRuntime.runtime;
    const denied = responseRecorder();
    await datasetDeleteRoute(
      request({
        method: 'POST',
        url: '/api/core/dataset/delete',
        headers: { 'idempotency-key': 'dataset-del-denied' },
        body: { datasetId },
      }),
      denied.response,
    );
    expect((denied.result().body as { code: number }).code).toBe(501061);
  });

  it('ACC-DELETE-002 / TEST-REP-DELETE-001 handles collection delete and write permission', async () => {
    const built = buildRuntime({ permissionMask: 2 });
    state.runtime = built.runtime;
    const allowed = responseRecorder();
    await collectionDeleteRoute(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/delete',
        headers: { 'idempotency-key': 'collection-del-1' },
        body: { collectionId },
      }),
      allowed.response,
    );
    expect((allowed.result().body as { data: { jobId: string } }).data.jobId).toBe(jobId);
    expect(built.calls.some((call) => call.method === 'requestCollectionDelete')).toBe(true);

    const deniedRuntime = buildRuntime({ permissionMask: 1 });
    state.runtime = deniedRuntime.runtime;
    const denied = responseRecorder();
    await collectionDeleteRoute(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/delete',
        headers: { 'idempotency-key': 'collection-del-denied' },
        body: { collectionId },
      }),
      denied.response,
    );
    expect((denied.result().body as { code: number }).code).toBe(501070);
  });

  it('ACC-DELETE-003 returns dataId and state without exposing job internals', async () => {
    const built = buildRuntime({ permissionMask: 2 });
    state.runtime = built.runtime;
    const recorder = responseRecorder();
    await dataDeleteRoute(
      request({
        method: 'POST',
        url: '/api/core/dataset/data/delete',
        headers: { 'idempotency-key': 'data-del-1' },
        body: { dataId },
      }),
      recorder.response,
    );
    expect(recorder.result().body).toMatchObject({
      data: { dataId, state: 'queued' },
    });
    expect(recorder.result().body).not.toHaveProperty('jobId');
  });

  it('ACC-DELETE-004 returns job progress and failure pages with hashed resource ids', async () => {
    const built = buildRuntime();
    state.runtime = built.runtime;
    const job = responseRecorder();
    await jobRoute(
      request({
        method: 'GET',
        url: `/api/core/dataset/delete-jobs/${jobId}`,
        query: { jobId },
      }),
      job.response,
    );
    expect(job.result().body).toMatchObject({
      data: { state: 'failed', stage: 'vector', progress: 40 },
    });

    const failures = responseRecorder();
    await failuresRoute(
      request({
        method: 'GET',
        url: `/api/core/dataset/delete-jobs/${jobId}/failures`,
        query: { jobId },
      }),
      failures.response,
    );
    const failureData = (
      failures.result().body as {
        data: { total: number; cursor: string; list: Array<Record<string, unknown>> };
      }
    ).data;
    expect(failureData.total).toBe(1);
    expect(failureData.cursor).toBe('cursor-1');
    expect(failureData.list[0]?.resourceIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(failureData)).not.toContain('internal-vector-key');
    expect(
      (built.calls.find((call) => call.method === 'listFailures')?.input as { limit: number })
        .limit,
    ).toBe(20);
  });

  it('ACC-DELETE-005 retries only via retryDeleteJob and maps missing jobs to 501024', async () => {
    const built = buildRuntime();
    state.runtime = built.runtime;
    const retry = responseRecorder();
    await retryRoute(
      request({
        method: 'POST',
        url: `/api/core/dataset/delete-jobs/${jobId}/retry`,
        query: { jobId },
        headers: { 'idempotency-key': 'retry-1' },
        body: {},
      }),
      retry.response,
    );
    expect(retry.result().body).toMatchObject({ data: { accepted: true } });
    expect(built.calls.some((call) => call.method === 'retryDeleteJob')).toBe(true);
    expect(built.retryJob).not.toHaveBeenCalled();

    const missing = buildRuntime({ missingJob: true });
    state.runtime = missing.runtime;
    const denied = responseRecorder();
    await retryRoute(
      request({
        method: 'POST',
        url: `/api/core/dataset/delete-jobs/${jobId}/retry`,
        query: { jobId },
        headers: { 'idempotency-key': 'retry-missing' },
        body: {},
      }),
      denied.response,
    );
    expect((denied.result().body as { code: number }).code).toBe(501024);
  });
});
