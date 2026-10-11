import type { NextApiRequest, NextApiResponse } from 'next';
import { describe, expect, it, vi } from 'vitest';
import { ApiErrorException, createApiError } from '../../packages/contracts/src/index';
import { ImportSourceService } from '../../packages/service/src/index';
import type { RequestContext } from '../../packages/service/src/ports/types';

const routeContext: RequestContext = {
  requestId: 'req-ingest-fault-route',
  tenant: { teamId: 'team-a', tmbId: 'tmb-a', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};
const routeState = vi.hoisted(() => ({ runtime: undefined as unknown }));
vi.mock('../../projects/app/src/runtime', () => ({
  getRuntime: async () => routeState.runtime,
}));
vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context: routeContext, subject: routeContext.tenant }),
}));

function responseRecorder() {
  let status = 200;
  let body: unknown = null;
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

const context: RequestContext = {
  requestId: 'req-ingest-fault',
  tenant: { teamId: 'team-a', tmbId: 'tmb-a', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
};

const collection = {
  teamId: 'team-a',
  datasetId: 'dataset-a',
  parentId: null,
  type: 'file',
  name: 'n',
  tagIds: [],
  sourceRef: 'ref',
};

describe('P4-12 ingest fault classification', () => {
  it('[TEST-FI-INGEST-001][ACC-PARSE-001] surfaces parser failures as stable errors and does not fabricate success', async () => {
    const service = new ImportSourceService({
      collections: { create: async () => ({ collectionId: 'c1' }) } as never,
      sourceProvider: {
        read: async () => {
          throw new ApiErrorException(
            createApiError({ code: 501057, requestId: context.requestId, params: {} }),
          );
        },
        preview: async () => {
          throw new Error('unused');
        },
      },
      trainingProcessor: { process: async () => ({ state: 'success' }) },
    });
    let created = 0;
    const tracked = new ImportSourceService({
      collections: {
        create: async () => {
          created += 1;
          return { collectionId: 'c1' };
        },
      } as never,
      sourceProvider: {
        read: async () => {
          throw new ApiErrorException(
            createApiError({ code: 501057, requestId: context.requestId, params: {} }),
          );
        },
        preview: async () => ({ rawText: '', contentHash: 'x' }),
      },
      trainingProcessor: { process: async () => ({ state: 'success' }) },
    });
    await expect(
      service.createCollectionFromSource(
        { collection, sourceType: 'file', sourceRef: 'f', options: { timeoutMs: 1 } },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501057 } });
    await expect(
      tracked.createCollectionFromSource(
        { collection, sourceType: 'file', sourceRef: 'f', options: { timeoutMs: 1 } },
        context,
      ),
    ).rejects.toBeInstanceOf(ApiErrorException);
    expect(created).toBe(0);
  });

  it('[TEST-FI-INGEST-001][ACC-RULE-003] does not enqueue when QueuePort is missing (501062 before side effects)', async () => {
    let created = 0;
    const service = new ImportSourceService({
      collections: {
        create: async () => {
          created += 1;
          return { collectionId: 'c1' };
        },
      } as never,
      sourceProvider: {
        read: async () => ({ rawText: 'content', contentHash: 'h' }),
        preview: async () => ({ rawText: 'content', contentHash: 'h' }),
      },
      trainingProcessor: { process: async () => ({ state: 'success' }) },
    });
    await expect(
      service.createCollectionFromSource(
        { collection, sourceType: 'text', sourceRef: 'c', options: { timeoutMs: 1 } },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501062 } });
    expect(created).toBe(0);
  });

  it('[TEST-FI-INGEST-001][ACC-INGEST-001] surfaces a provider parser failure through the real text route with no side effects', async () => {
    let created = 0;
    routeState.runtime = {
      collectionRepository: {
        create: async () => {
          created += 1;
          return { collectionId: 'c1' };
        },
      },
      processingRepository: { enqueue: async () => ({ taskId: 't', jobId: 'j' }) },
      ports: {
        datasetSourceProvider: {
          read: async () => {
            throw new ApiErrorException(
              createApiError({ code: 501057, requestId: routeContext.requestId, params: {} }),
            );
          },
          preview: async () => ({ rawText: '', contentHash: 'x' }),
        },
        trainingProcessor: { process: async () => ({ state: 'success' }) },
      },
    };
    const route =
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/text');
    const recorder = responseRecorder();
    await route.default(
      {
        method: 'POST',
        url: '/api/core/dataset/collection/create/text',
        headers: {},
        query: {},
        body: { datasetId: '000000000000000000000010', text: 'hi' },
      } as unknown as NextApiRequest,
      recorder.response,
    );
    expect((recorder.result().body as { code?: number }).code).toBe(501057);
    expect(created).toBe(0);
  });
});
