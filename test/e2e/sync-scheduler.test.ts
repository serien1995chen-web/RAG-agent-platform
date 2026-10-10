import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BullMqQueueAdapter,
  buildSyncJobId,
  type QueueName,
  type QueuePort,
} from '../../packages/dal/src';
import type {
  CollectionSnapshot,
  KnowledgeBaseSnapshot,
  RequestContext,
} from '../../packages/service/src/ports/types';
import { DatasetSyncApplicationService } from '../../packages/service/src/modules/collection/application/sync.service';
import { reconcileDatasetSyncSchedulers } from '../../packages/service/src/shared/runtime/dataset-sync-scheduler';

const context: RequestContext = {
  requestId: 'req-sync-scheduler',
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

const state = vi.hoisted(() => ({
  runtime: undefined as unknown,
}));

vi.mock('../../projects/app/src/runtime', () => ({
  getRuntime: async () => state.runtime,
}));

vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context, subject: context.tenant }),
}));

class FakeQueue implements QueuePort {
  readonly calls: Array<{
    queue: string;
    jobId: string;
    payload: unknown;
    options: { attempts?: number } | undefined;
  }> = [];
  private readonly jobs = new Set<string>();

  async enqueue(
    queue: QueueName,
    jobId: string,
    payload: unknown,
    options?: { attempts?: number },
  ): Promise<{ jobId: string; enqueued: boolean }> {
    this.calls.push({ queue, jobId, payload, options });
    if (this.jobs.has(jobId)) return { jobId, enqueued: false };
    this.jobs.add(jobId);
    return { jobId, enqueued: true };
  }

  async remove(): Promise<void> {}
  async close(): Promise<void> {}
}

function linkCollection(overrides: Partial<CollectionSnapshot> = {}): CollectionSnapshot {
  return {
    collectionId,
    teamId: context.tenant.teamId,
    datasetId,
    parentId: null,
    type: 'link',
    name: 'link',
    tagIds: [],
    version: 1,
    createTime: '2026-10-10T00:00:00.000Z',
    updateTime: '2026-10-10T00:00:00.000Z',
    ...overrides,
  };
}

function dataset(autoSync: boolean): KnowledgeBaseSnapshot {
  return {
    datasetId,
    teamId: context.tenant.teamId,
    parentId: null,
    type: 'knowledge',
    name: 'dataset',
    vectorModel: 'bge-m3',
    inheritPermission: true,
    autoSync,
    deleteTime: null,
    version: 1,
    createTime: '2026-10-10T00:00:00.000Z',
    updateTime: '2026-10-10T00:00:00.000Z',
  };
}

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
  body?: unknown;
  headers?: Record<string, string>;
}): NextApiRequest {
  return {
    method: input.method,
    url: input.url,
    query: {},
    body: input.body,
    headers: input.headers ?? {},
  } as unknown as NextApiRequest;
}

describe('autoSync chain and scheduler (P3-06)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects non-link/apiFile collections with the registered provider error', async () => {
    const service = new DatasetSyncApplicationService({
      collections: {
        get: async () => linkCollection({ type: 'folder' }),
        list: async () => ({ total: 0, list: [], cursor: null }),
        create: async () => ({ collectionId }),
        update: async () => ({ version: 2 }),
        deleteTree: async () => ({ deleteJobId: 'delete' }),
      },
      knowledgeBase: {
        get: async () => dataset(true),
        create: async () => ({ datasetId, version: 1 }),
        update: async () => ({ version: 2 }),
        softDelete: async () => ({ deleteJobId: 'delete' }),
      },
      processingJobs: {
        enqueue: async () => ({ taskId: 'task', jobId: 'job' }),
        claim: async () => ({ taskId: 'task', lockTime: new Date().toISOString() }),
        renew: async () => ({ lockTime: new Date().toISOString() }),
        finish: async () => undefined,
      },
      queue: new FakeQueue(),
    });

    await expect(
      service.enqueueManualSync(
        { collectionId, idempotencyKey: 'idem-1', options: { timeoutMs: 5_000 } },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501019 } });
  });

  it('writes autoSync before enqueue and keeps repeated manual sync on one jobId', async () => {
    const events: string[] = [];
    let current = dataset(false);
    const queue = new FakeQueue();
    const service = new DatasetSyncApplicationService({
      collections: {
        get: async () => linkCollection(),
        list: async () => ({ total: 1, list: [linkCollection()], cursor: null }),
        create: async () => ({ collectionId }),
        update: async () => ({ version: 2 }),
        deleteTree: async () => ({ deleteJobId: 'delete' }),
      },
      knowledgeBase: {
        get: async () => current,
        create: async () => ({ datasetId, version: 1 }),
        update: async (input) => {
          events.push('mongo:autoSync');
          current = { ...current, autoSync: input.patch.autoSync ?? current.autoSync, version: 2 };
          return { version: current.version };
        },
        softDelete: async () => ({ deleteJobId: 'delete' }),
      },
      processingJobs: {
        enqueue: async () => ({ taskId: 'task', jobId: 'job' }),
        claim: async () => ({ taskId: 'task', lockTime: new Date().toISOString() }),
        renew: async () => ({ lockTime: new Date().toISOString() }),
        finish: async () => undefined,
      },
      queue: {
        enqueue: async (queueName, jobId, payload, options) => {
          events.push('queue:sync');
          return queue.enqueue(queueName, jobId, payload, options);
        },
        remove: async () => undefined,
        close: async () => undefined,
      },
    });

    const first = await service.enqueueManualSync(
      { collectionId, idempotencyKey: 'idem-1', options: { timeoutMs: 5_000 } },
      context,
    );
    const second = await service.enqueueManualSync(
      { collectionId, idempotencyKey: 'idem-2', options: { timeoutMs: 5_000 } },
      context,
    );

    expect(events).toEqual(['mongo:autoSync', 'queue:sync', 'queue:sync']);
    expect(first.jobId).toBe(buildSyncJobId(context.tenant.teamId, datasetId));
    expect(second.jobId).toBe(first.jobId);
    expect(new Set(queue.calls.map((call) => call.jobId)).size).toBe(1);
    expect(queue.calls.every((call) => call.options?.attempts === 3)).toBe(true);
  });

  it('writes parse/chunk task facts before queue delivery and counts partial failures', async () => {
    const events: string[] = [];
    const queue = new FakeQueue();
    const service = new DatasetSyncApplicationService({
      collections: {
        get: async () => linkCollection(),
        list: async () => ({
          total: 3,
          list: [
            linkCollection(),
            linkCollection({ collectionId: '000000000000000000000103', type: 'apiFile' }),
            linkCollection({ collectionId: '000000000000000000000104', type: 'folder' }),
          ],
          cursor: null,
        }),
        create: async () => ({ collectionId }),
        update: async () => ({ version: 2 }),
        deleteTree: async () => ({ deleteJobId: 'delete' }),
      },
      knowledgeBase: {
        get: async () => dataset(true),
        create: async () => ({ datasetId, version: 1 }),
        update: async () => ({ version: 2 }),
        softDelete: async () => ({ deleteJobId: 'delete' }),
      },
      processingJobs: {
        enqueue: async (input) => {
          events.push(`mongo:${input.job.jobId}`);
          return { taskId: `task-${input.job.jobId}`, jobId: input.job.jobId };
        },
        claim: async () => ({ taskId: 'task', lockTime: new Date().toISOString() }),
        renew: async () => ({ lockTime: new Date().toISOString() }),
        finish: async () => undefined,
      },
      queue: {
        enqueue: async (queueName, jobId, payload, options) => {
          events.push(`queue:${jobId}`);
          return queue.enqueue(queueName, jobId, payload, options);
        },
        remove: async () => undefined,
        close: async () => undefined,
      },
    });

    const result = await service.sync(
      { datasetId, idempotencyKey: 'idem-sync', options: { timeoutMs: 5_000 } },
      context,
    );
    expect(result).toEqual({ state: 'active', changed: 2, removed: 0 });
    expect(events.filter((event) => event.startsWith('mongo:'))).toHaveLength(4);
    expect(events.filter((event) => event.startsWith('queue:'))).toHaveLength(4);
    for (let index = 0; index < events.length; index += 2) {
      expect(events[index]?.startsWith('mongo:')).toBe(true);
      expect(events[index + 1]?.startsWith('queue:')).toBe(true);
    }
    expect(queue.calls.every((call) => call.options?.attempts === 3)).toBe(true);

    const failingService = new DatasetSyncApplicationService({
      collections: {
        get: async () => linkCollection(),
        list: async () => ({ total: 1, list: [linkCollection()], cursor: null }),
        create: async () => ({ collectionId }),
        update: async () => ({ version: 2 }),
        deleteTree: async () => ({ deleteJobId: 'delete' }),
      },
      knowledgeBase: {
        get: async () => dataset(true),
        create: async () => ({ datasetId, version: 1 }),
        update: async () => ({ version: 2 }),
        softDelete: async () => ({ deleteJobId: 'delete' }),
      },
      processingJobs: {
        enqueue: async (input) => ({ taskId: `task-${input.job.jobId}`, jobId: input.job.jobId }),
        claim: async () => ({ taskId: 'task', lockTime: new Date().toISOString() }),
        renew: async () => ({ lockTime: new Date().toISOString() }),
        finish: async () => undefined,
      },
      queue: {
        enqueue: async () => {
          throw new Error('redis unavailable');
        },
        remove: async () => undefined,
        close: async () => undefined,
      },
    });
    await expect(
      failingService.sync(
        { datasetId, idempotencyKey: 'idem-fail', options: { timeoutMs: 5_000 } },
        context,
      ),
    ).resolves.toEqual({
      state: 'error',
      changed: 0,
      removed: 0,
      errorMsg: 'dataset.sync.partial_failure',
    });
  });

  it('keeps scheduler upserts idempotent, preserves unknown schedulers and retries failures', async () => {
    const schedulers = new Map<string, Record<string, unknown>>();
    let failures = 3;
    const queue = {
      getJobSchedulers: async () => [
        ...schedulers.values(),
        { key: 'unknown', name: 'other', template: { data: {} } },
      ],
      upsertJobScheduler: async (
        key: string,
        _repeat: unknown,
        template: Record<string, unknown>,
      ) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('redis unavailable');
        }
        schedulers.set(key, { key, name: 'sync', template });
      },
      removeJobScheduler: async (key: string) => schedulers.delete(key),
    };
    const lock = {
      isHeld: () => true,
      acquire: async () => true,
      renew: async () => true,
      release: async () => undefined,
    };

    const args = {
      queue: queue as never,
      lock,
      listExpectedDatasetIds: async () => [datasetId],
      listRemovedDatasetIds: async () => [],
    };
    await expect(reconcileDatasetSyncSchedulers(args)).resolves.toMatchObject({ error: 1 });
    await expect(reconcileDatasetSyncSchedulers(args)).resolves.toMatchObject({ error: 1 });
    await expect(reconcileDatasetSyncSchedulers(args)).resolves.toMatchObject({ error: 1 });
    await expect(reconcileDatasetSyncSchedulers(args)).resolves.toMatchObject({
      created: 1,
      skipped_mismatch: 1,
    });
    await expect(reconcileDatasetSyncSchedulers(args)).resolves.toMatchObject({
      created: 0,
      skipped_mismatch: 1,
    });
    expect(schedulers.has(datasetId)).toBe(true);
    expect(schedulers.has('unknown')).toBe(false);
  });

  it('serves API-COL-015 as a real route', async () => {
    const queue = new FakeQueue();
    state.runtime = {
      clients: { redis: {} },
      collectionRepository: {
        get: async () => linkCollection(),
      },
      knowledgeBaseRepository: {
        get: async () => dataset(true),
        update: async () => ({ version: 2 }),
      },
      processingRepository: {
        enqueue: async () => ({ taskId: 'task', jobId: 'job' }),
      },
    };
    vi.spyOn(BullMqQueueAdapter.prototype, 'enqueue').mockImplementation(
      async (queueName, jobId, payload, options) =>
        queue.enqueue(queueName, jobId, payload, options),
    );
    vi.spyOn(BullMqQueueAdapter.prototype, 'close').mockResolvedValue(undefined);

    const route = await import('../../projects/app/src/pages/api/core/dataset/collection/sync');
    const recorder = responseRecorder();
    await route.default(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/sync',
        body: { collectionId, 'Idempotency-Key': 'idem-route' },
      }),
      recorder.response,
    );

    expect(recorder.result().status, JSON.stringify(recorder.result().body)).toBe(200);
    expect(recorder.result().body).toMatchObject({
      code: 200,
      data: { jobId: buildSyncJobId(context.tenant.teamId, datasetId) },
    });
  });
});
