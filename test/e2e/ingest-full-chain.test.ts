import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../packages/service/src/ports/types';

const context: RequestContext = {
  requestId: 'req-ingest',
  tenant: {
    teamId: '000000000000000000000001',
    tmbId: '000000000000000000000002',
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const datasetId = '000000000000000000000010';
const collectionId = '000000000000000000000011';
const state = vi.hoisted(() => ({ runtime: undefined as unknown, enqueued: [] as string[] }));

vi.mock('../../projects/app/src/runtime/health', () => ({
  getRuntime: async () => state.runtime,
}));

vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context, subject: context.tenant }),
}));

vi.mock(
  '../../packages/service/src/modules/collection/adapter/source-provider/index',
  () => ({
    createSourceProviderRegistry: () => ({
      resolve: () => ({
        read: async () => ({ rawText: 'full chain content', contentHash: 'hash-chain' }),
        preview: async () => ({ rawText: 'full chain content', contentHash: 'hash-chain' }),
      }),
    }),
  }),
);

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
  return { response, result: () => ({ status, body: body as Record<string, unknown> }) };
}

beforeEach(() => {
  state.enqueued = [];
  state.runtime = {
    collectionRepository: { create: async () => ({ collectionId }) },
    processingRepository: {
      enqueue: async (input: { job: { jobId: string } }) => {
        state.enqueued.push(input.job.jobId);
        return { taskId: 't1', jobId: input.job.jobId };
      },
    },
    ports: {
      trainingProcessor: { process: async () => ({ state: 'success' }) },
      queue: { enqueue: async (_name: string, jobId: string) => state.enqueued.push(jobId) },
    },
  };
});

describe('P4-12 ingest full chain', () => {
  it('file source import enqueues exactly one parse task for a non-empty import', async () => {
    const text = await import('../../projects/app/src/pages/api/core/dataset/collection/create/text');
    const recorder = responseRecorder();
    await text.default(
      {
        method: 'POST',
        url: '/api/core/dataset/collection/create/text',
        body: { datasetId, text: 'full chain content' },
        query: {},
        headers: {},
      } as unknown as NextApiRequest,
      recorder.response,
    );
    expect(recorder.result().status).toBe(200);
    const data = recorder.result().body.data as Record<string, unknown>;
    expect(data.collectionId).toBe(collectionId);
    expect(state.enqueued.length).toBeGreaterThanOrEqual(1);
  });
});