import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessingApplicationService } from '../../packages/service/src/modules/processing/application';
import type { RequestContext } from '../../packages/service/src/ports/types';

const context: RequestContext = {
  requestId: 'req-training-routes',
  tenant: {
    teamId: '000000000000000000000001',
    tmbId: '000000000000000000000002',
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const state = vi.hoisted(() => ({
  runtime: undefined as unknown,
}));

vi.mock('../../projects/app/src/runtime', () => ({
  getRuntime: async () => state.runtime,
}));

vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context, subject: context.tenant }),
}));

const taskId = '000000000000000000000101';
const datasetId = '000000000000000000000102';
const collectionId = '000000000000000000000103';
const dataId = '000000000000000000000104';

const taskView = {
  taskId,
  jobId: `${context.tenant.teamId}:${dataId}:qa:1`,
  datasetId,
  collectionId,
  dataId,
  mode: 'qa',
  retryCount: 2,
  lockTime: '2026-10-10T00:10:00.000Z',
  weight: 0,
  derivedState: 'temporaryFailure',
  error: {
    messageKey: 'dataset.task.temporary_failure',
    retryable: 'retryable' as const,
    category: 'provider' as const,
  },
};

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
  query?: Record<string, string>;
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

function capabilityRepository(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enqueue: async () => ({ taskId, jobId: taskView.jobId }),
    claim: async () => ({ taskId, lockTime: new Date().toISOString() }),
    renew: async () => ({ lockTime: new Date().toISOString() }),
    finish: async () => undefined,
    finishWithLease: async () => undefined,
    resumeTask: async () => ({ taskId, retryCount: 3 }),
    getTaskDetail: async () => ({ task: taskView, derivedState: taskView.derivedState }),
    listTaskErrors: async () => ({ total: 1, list: [taskView], cursor: null }),
    getQueueStats: async () => [{ mode: 'qa', depth: 1, running: 0 }],
    updateTrainingData: async () => ({ acceptedCount: 1 }),
    deleteTrainingData: async () => ({ deletedCount: 1 }),
    listCollectionErrors: async () => [taskView],
    hasError: async () => true,
    ...overrides,
  };
}

beforeEach(() => {
  state.runtime = {
    processingService: {
      getTaskDetail: async () => ({ task: taskView, derivedState: taskView.derivedState }),
      listTaskErrors: async () => ({ total: 1, list: [taskView], cursor: null }),
      resumeTask: async () => ({ taskId, retryCount: 3 }),
      getQueueStats: async () => [{ mode: 'qa', depth: 1, running: 0 }],
      updateTrainingData: async () => ({ acceptedCount: 1 }),
      deleteTrainingData: async () => ({ deletedCount: 1 }),
      listCollectionErrors: async () => [taskView],
      hasError: async () => true,
    },
  };
});

describe('training task routes (P3-08 / API-TASK-001..009)', () => {
  it('serves all nine registered routes with real DTO parsing and no 501999', async () => {
    const routes = [
      [
        await import('../../projects/app/src/pages/api/core/dataset/training/detail'),
        'GET',
        '/api/core/dataset/training/detail',
        { taskId },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/training/errors'),
        'GET',
        '/api/core/dataset/training/errors',
        { datasetId, limit: 50 },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/training/resume'),
        'POST',
        '/api/core/dataset/training/resume',
        { taskId, reason: 'operator retry', 'Idempotency-Key': 'idem-resume' },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/training/updateTrainingData'),
        'PUT',
        '/api/core/dataset/training/updateTrainingData',
        { datasetId, mode: 'qa' },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/training/deleteTrainingData'),
        'POST',
        '/api/core/dataset/training/deleteTrainingData',
        { collectionId },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/training/queue'),
        'GET',
        '/api/core/dataset/training/queue',
        { datasetId },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/training/errors'),
        'POST',
        '/api/core/dataset/training/errors',
        { datasetId },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/training/collectionErrors'),
        'POST',
        '/api/core/dataset/training/collectionErrors',
        { collectionId },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/training/hasError'),
        'GET',
        '/api/core/dataset/training/hasError',
        { datasetId },
      ],
    ] as const;

    for (const [module, method, url, value] of routes) {
      const recorder = responseRecorder();
      const input = method === 'GET' ? { query: value as Record<string, string> } : { body: value };
      await module.default(request({ method, url, ...input }), recorder.response);
      expect(recorder.result().status, `${url} ${JSON.stringify(recorder.result().body)}`).toBe(
        200,
      );
      expect(JSON.stringify(recorder.result().body)).not.toContain('completed');
      expect(JSON.stringify(recorder.result().body)).not.toContain('raw provider error');
    }
  });

  it('enforces read/write/manage permissions in the application layer', async () => {
    const repository = capabilityRepository();
    const service = new ProcessingApplicationService({ repository: repository as never });
    const denied: RequestContext = {
      ...context,
      permission: { canRead: false, canWrite: false, canManage: false, isOwner: false },
    };
    await expect(
      service.getTaskDetail({ taskId, options: { timeoutMs: 5_000 } }, denied),
    ).rejects.toMatchObject({ error: { code: 501027, params: { requiredRole: 'read' } } });
    await expect(
      service.resumeTask({ taskId, reason: 'manual', options: { timeoutMs: 5_000 } }, denied),
    ).rejects.toMatchObject({ error: { code: 501027, params: { requiredRole: 'write' } } });
    await expect(
      service.deleteTrainingData({ collectionId, options: { timeoutMs: 5_000 } }, denied),
    ).rejects.toMatchObject({ error: { code: 501027, params: { requiredRole: 'manage' } } });
  });

  it('validates error/update/delete scopes and returns stable application results', async () => {
    const calls: string[] = [];
    const repository = capabilityRepository({
      listTaskErrors: async () => {
        calls.push('listTaskErrors');
        return { total: 1, list: [taskView], cursor: null };
      },
      resumeTask: async () => {
        calls.push('resumeTask');
        return { taskId, retryCount: 3 };
      },
      updateTrainingData: async () => {
        calls.push('updateTrainingData');
        return { acceptedCount: 2 };
      },
      deleteTrainingData: async () => {
        calls.push('deleteTrainingData');
        return { deletedCount: 1 };
      },
    });
    const service = new ProcessingApplicationService({ repository: repository as never });

    await expect(
      service.listTaskErrors({ limit: 20, options: { timeoutMs: 5_000 } }, context),
    ).rejects.toMatchObject({ error: { code: 501048 } });
    await expect(
      service.updateTrainingData({ mode: 'qa', options: { timeoutMs: 5_000 } }, context),
    ).rejects.toMatchObject({ error: { code: 501048 } });
    await expect(
      service.deleteTrainingData({ collectionId, dataId, options: { timeoutMs: 5_000 } }, context),
    ).rejects.toMatchObject({ error: { code: 501048 } });

    await expect(
      service.resumeTask({ taskId, reason: 'manual', options: { timeoutMs: 5_000 } }, context),
    ).resolves.toEqual({ taskId, retryCount: 3 });
    await expect(
      service.updateTrainingData({ datasetId, mode: 'qa', options: { timeoutMs: 5_000 } }, context),
    ).resolves.toEqual({ acceptedCount: 2 });
    await expect(
      service.deleteTrainingData({ collectionId, options: { timeoutMs: 5_000 } }, context),
    ).resolves.toEqual({ deletedCount: 1 });
    expect(calls).toEqual(['resumeTask', 'updateTrainingData', 'deleteTrainingData']);
  });
});
