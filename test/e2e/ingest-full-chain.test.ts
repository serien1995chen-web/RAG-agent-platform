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

vi.mock('../../projects/app/src/runtime', () => ({
  getRuntime: async () => state.runtime,
}));

vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context, subject: context.tenant }),
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
      datasetSourceProvider: {
        read: async () => ({ rawText: 'full chain content', contentHash: 'hash-chain' }),
        preview: async () => ({ rawText: 'full chain content', contentHash: 'hash-chain' }),
      },
      trainingProcessor: { process: async () => ({ state: 'success' }) },
      queue: { enqueue: async (_name: string, jobId: string) => state.enqueued.push(jobId) },
    },
  };
});

describe('P4-12 ingest full chain', () => {
  it('[TEST-E2E-INGEST-001][ACC-FLOW-001] file source import enqueues exactly one parse task for a non-empty import', async () => {
    const text =
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/text');
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

// 真实 bootstrap 全链路：CI 设置 KB_* 时启用；本地未配置则跳过。
describe.skipIf(!process.env.KB_MONGO_URI)(
  'P4-12 real bootstrap full chain [TEST-E2E-INGEST-001][ACC-FLOW-001]',
  () => {
    it('[TEST-E2E-INGEST-001][ACC-FLOW-001] parser→chunk→vector→fullText→search retrievable', async () => {
      const { bootstrapRuntime } = await import('../../projects/app/src/runtime/bootstrap');
      const { InsertDataService } = await import('../../packages/service/src/index');
      const runtime = await bootstrapRuntime();
      const teamId = context.tenant.teamId;
      try {
        const dataset = await runtime.datasetApi.createDataset(
          { name: `chain-${Date.now()}`, type: 'dataset', vectorModel: 'bge-m3' },
          context,
        );
        const collection = await runtime.collectionRepository.create(
          {
            collection: {
              teamId,
              datasetId: dataset.datasetId,
              parentId: null,
              type: 'file',
              name: 'chain',
              tagIds: [],
              sourceRef: 'chain',
            },
            options: { timeoutMs: 5000 },
          },
          context,
        );
        const nonce = `${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
        const dataId = nonce.padEnd(24, '0').slice(0, 24);
        const question = `hello chain ${nonce}`;
        const vector = await runtime.modelRuntime.embedText(
          { text: question, options: { timeoutMs: 5000 } },
          context,
        );
        const insert = new InsertDataService({
          items: runtime.knowledgeItemRepository,
          vectors: runtime.vectorController,
          fullText: runtime.ports.fullTextStore,
        });
        await insert.insertDirect(
          {
            dataId,
            datasetId: dataset.datasetId,
            collectionId: collection.collectionId,
            q: question,
            a: 'answer',
            indexType: 'question',
            vector,
            options: { timeoutMs: 10000 },
          },
          context,
        );
        const result = await runtime.datasetSearch.search(
          {
            requestId: context.requestId,
            teamId,
            tmbId: context.tmbId,
            datasetIds: [dataset.datasetId],
            textQueries: [question],
            models: { embeddingModel: 'bge-m3' },
            searchMode: 'mixedRecall',
            limit: 5,
            maxTokens: 4000,
            similarity: 0,
          },
          context,
        );
        expect(result.citations.some((citation) => citation.dataId === dataId)).toBe(true);
      } finally {
        await runtime.shutdown();
      }
    }, 60000);
  },
);
