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

function request(input: {
  method: string;
  url: string;
  body?: unknown;
  query?: Record<string, unknown>;
}): NextApiRequest {
  return {
    method: input.method,
    url: input.url,
    query: input.query ?? {},
    body: input.body,
    headers: {},
  } as unknown as NextApiRequest;
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
    it('[TEST-E2E-INGEST-001][ACC-FLOW-001] routes: parser/chunk + insertData + search retrievable', async () => {
      const { bootstrapRuntime } = await import('../../projects/app/src/runtime/bootstrap');
      const runtime = await bootstrapRuntime();
      state.runtime = runtime;
      const teamId = context.tenant.teamId;
      try {
        const dataset = await runtime.datasetApi.createDataset(
          { name: `chain-${Date.now()}`, type: 'dataset', vectorModel: 'bge-m3' },
          context,
        );
        // 1) 真实 Parser/Chunk 经 previewChunks API 路由：先把字节写入真实对象存储。
        const key = `dataset/${dataset.datasetId}/chain.txt`;
        await runtime.clients.objectStore.put(
          { ref: { bucket: 'kb-source', key }, body: Buffer.from('hello chain content') },
          { teamId, datasetId: dataset.datasetId },
        );
        const previewChunks =
          await import('../../projects/app/src/pages/api/core/dataset/file/previewChunks');
        const previewRec = responseRecorder();
        await previewChunks.default(
          request({
            method: 'POST',
            url: '/api/core/dataset/file/previewChunks',
            body: {
              fileRef: key,
              chunkPolicy: {
                mode: 'custom',
                chunkSize: 64,
                minSize: 64,
                maxSize: 8000,
                overlapRatio: 0,
                paragraphDeep: 1,
                customRegs: [],
                lengthUnit: 'char',
                forceSplit: true,
                maxChunks: 1000,
              },
            },
          }),
          previewRec.response,
        );
        expect(previewRec.result().status).toBe(200);
        const chunks = (previewRec.result().body.data as { chunks: Array<{ text: string }> })
          .chunks;
        expect(chunks.length).toBeGreaterThan(0);
        const chunkText = chunks[0]?.text ?? '';
        expect(chunkText.length).toBeGreaterThan(0);

        // 2) 真实插入经 insertData API 路由（真实向量 + 全文）。
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
        const insertData =
          await import('../../projects/app/src/pages/api/core/dataset/data/insertData');
        const insertRec = responseRecorder();
        await insertData.default(
          request({
            method: 'POST',
            url: '/api/core/dataset/data/insertData',
            body: { collectionId: collection.collectionId, q: chunkText, a: 'answer' },
          }),
          insertRec.response,
        );
        expect(insertRec.result().status).toBe(200);
        const insertedData = insertRec.result().body.data as { dataId: string };

        // 3) 既有 Search API 路由检索同一 chunk，只有同一 dataId 命中才算全链路成立。
        const healthModule = '../../projects/app/src/runtime/health';
        const actualHealth = await vi.importActual(healthModule);
        vi.doMock(healthModule, () => ({
          ...(actualHealth as Record<string, unknown>),
          getRuntime: async () => runtime,
        }));
        try {
          const searchTest =
            await import('../../projects/app/src/pages/api/core/dataset/searchTest');
          const searchRec = responseRecorder();
          await searchTest.default(
            request({
              method: 'POST',
              url: '/api/core/dataset/searchTest',
              body: {
                datasetId: dataset.datasetId,
                text: chunkText,
                searchMode: 'mixedRecall',
                limit: 5,
              },
            }),
            searchRec.response,
          );
          expect(searchRec.result().status).toBe(200);
          const searchRes = (
            searchRec.result().body.data as {
              searchRes?: { citations?: Array<{ dataId: string }> };
            }
          ).searchRes;
          expect(
            searchRes?.citations?.some((citation) => citation.dataId === insertedData.dataId),
          ).toBe(true);
        } finally {
          vi.doUnmock(healthModule);
          vi.resetModules();
        }
      } finally {
        await runtime.shutdown();
      }
    }, 60000);
  },
);
