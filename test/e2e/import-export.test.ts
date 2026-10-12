import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../packages/service/src/ports/types';

const TEAM_ID = '000000000000000000000001';
const DATASET_ID = '0000000000000000000000d1';
const COLLECTION_ID = '0000000000000000000000c1';

const context: RequestContext = {
  requestId: 'req-import-export',
  tenant: { teamId: TEAM_ID, tmbId: '000000000000000000000002', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const state = vi.hoisted(() => ({
  forceDuplicates: false,
  providerCalls: 0,
  runtime: undefined as unknown,
}));

vi.mock('../../projects/app/src/runtime', () => ({
  getRuntime: async () => state.runtime,
}));

vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context, subject: context.tenant }),
}));

function responseRecorder(): {
  response: NextApiResponse;
  result: () => {
    status: number;
    body: { data?: unknown; code?: number };
    sent: unknown;
    headers: Record<string, string>;
  };
} {
  let status = 200;
  let body: { data?: unknown; code?: number } = {};
  let sent: unknown;
  const headers: Record<string, string> = {};
  const response = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return response;
    },
    status(code: number) {
      status = code;
      return response;
    },
    json(value: unknown) {
      body = value as { data?: unknown; code?: number };
      return response;
    },
    send(value: unknown) {
      sent = value;
      return response;
    },
  } as unknown as NextApiResponse;
  return { response, result: () => ({ status, body, sent, headers }) };
}

function request(input: {
  method: string;
  url: string;
  query?: Record<string, string>;
  body?: unknown;
}): NextApiRequest {
  return {
    method: input.method,
    url: input.url,
    query: input.query ?? {},
    body: input.body,
    headers: {},
  } as unknown as NextApiRequest;
}

function buildRuntime() {
  return {
    collectionRepository: {
      list: async () => ({
        total: 1,
        list: [
          {
            collectionId: COLLECTION_ID,
            teamId: TEAM_ID,
            datasetId: DATASET_ID,
            parentId: null,
            type: 'apiFile',
            name: 'api',
            tagIds: [],
            sourceRef: `apiFile:cfg-1:/docs/a.md`,
            version: 1,
            createTime: 'now',
            updateTime: 'now',
          },
        ],
        cursor: null,
      }),
      create: async () => ({ collectionId: COLLECTION_ID }),
    },
    knowledgeItemService: {
      listItems: async () => ({
        total: 1,
        list: [
          {
            dataId: '0000000000000000000000aa',
            teamId: TEAM_ID,
            datasetId: DATASET_ID,
            collectionId: COLLECTION_ID,
            q: 'exported question',
            a: 'exported answer',
            indexes: [
              { indexId: 'i1', type: 'qa', dataId: '0000000000000000000000aa', text: 'exported' },
            ],
            metadata: { source: 'doc' },
            rebuilding: false,
            version: 1,
            createTime: 'now',
            updateTime: 'now',
          },
        ],
        cursor: null,
      }),
    },
    knowledgeItemRepository: {
      bulkUpsert: async () =>
        state.forceDuplicates ? { upserted: 0, duplicates: 1 } : { upserted: 1, duplicates: 0 },
    },
    vectorController: { insert: async () => ({ inserted: 1 }) },
    embeddingService: { embed: async () => [new Array<number>(1536).fill(0)] },
    fullTextStore: { write: async () => undefined },
    datasetSourceProvider: {
      read: async () => ({ rawText: 'x', contentHash: 'h' }),
      preview: async () => ({ rawText: 'x', contentHash: 'h' }),
      getCatalog: async () => {
        state.providerCalls += 1;
        return [{ id: 'n1', name: 'docs' }];
      },
      getPathNames: async () => '/docs/n1',
      list: async () => {
        state.providerCalls += 1;
        return [{ id: 'f1', name: 'a.md' }];
      },
    },
    ports: { fullTextStore: { write: async () => undefined } },
    clients: { redis: undefined, mongo: undefined },
    config: {
      system: { s3: { bucket: 'kb' } },
      datasetRuntime: { maxPushItems: 200, maxRequestBodyBytes: 10 * 1024 * 1024 },
    },
  };
}

beforeEach(() => {
  state.forceDuplicates = false;
  state.providerCalls = 0;
  state.runtime = buildRuntime();
});

describe('TEST-API-EXPORT-001 P4-10 export routes', () => {
  it('exports dataset as reversible JSONL/ZIP without internal object keys', async () => {
    const exportAll = (await import('../../projects/app/src/pages/api/core/dataset/exportAll'))
      .default;
    const jsonl = responseRecorder();
    await exportAll(
      request({
        method: 'GET',
        url: '/api/core/dataset/exportAll',
        query: { datasetId: DATASET_ID, format: 'jsonl' },
      }),
      jsonl.response,
    );
    const text = String(jsonl.result().sent);
    expect(text).toContain('exported question');
    expect(text).not.toContain('dataset/');
    expect(text).not.toContain('bucket');

    const zip = responseRecorder();
    await exportAll(
      request({
        method: 'GET',
        url: '/api/core/dataset/exportAll',
        query: { datasetId: DATASET_ID, format: 'zip' },
      }),
      zip.response,
    );
    expect(zip.result().headers['content-type']).toBe('application/zip');
    const buffer = zip.result().sent as Buffer;
    expect(buffer.subarray(0, 4).toString('binary')).toBe('PK\u0003\u0004');
    expect(buffer.toString('binary')).toContain('export.jsonl');
    // store 模式：压缩体即原文，可直接还原同一 JSONL
    expect(buffer.toString('utf8')).toContain('exported question');
  });

  it('exports a single collection as ndjson', async () => {
    const exportCollection = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/export')
    ).default;
    const res = responseRecorder();
    await exportCollection(
      request({
        method: 'GET',
        url: '/api/core/dataset/collection/export',
        query: { collectionId: COLLECTION_ID, format: 'jsonl' },
      }),
      res.response,
    );
    expect(res.result().headers['content-type']).toBe('application/x-ndjson');
    expect(String(res.result().sent)).toContain('exported answer');
  });
});

describe('TEST-API-IMPORT-001 P4-10 import routes', () => {
  it('imports jsonl rows and reports success/skipped counts', async () => {
    const importCollection = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/import')
    ).default;
    const jsonlFile = Buffer.from('{"q":"a?","a":"b"}\n{"q":"c?","a":"d"}\n');
    const res = responseRecorder();
    await importCollection(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/import',
        body: {
          datasetId: DATASET_ID,
          targetCollectionId: COLLECTION_ID,
          file: { filename: 'in.jsonl', content: jsonlFile },
        },
      }),
      res.response,
    );
    expect(res.result().status).toBe(200);
    const report = (res.result().body.data as { report: { success: number; skipped: number } })
      .report;
    expect(report.success).toBe(2);
    expect(report.skipped).toBe(0);

    state.forceDuplicates = true;
    const dup = responseRecorder();
    await importCollection(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/import',
        body: {
          datasetId: DATASET_ID,
          targetCollectionId: COLLECTION_ID,
          file: { filename: 'in.jsonl', content: jsonlFile },
        },
      }),
      dup.response,
    );
    const dupReport = (dup.result().body.data as { report: { skipped: number } }).report;
    expect(dupReport.skipped).toBe(2);
  });

  it('imports csv rows mapped through the parser markdown table', async () => {
    const importCollection = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/import')
    ).default;
    const csv = Buffer.from('q,a\nhello,world\nfoo,bar\n');
    const res = responseRecorder();
    await importCollection(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/import',
        body: {
          datasetId: DATASET_ID,
          targetCollectionId: COLLECTION_ID,
          file: { filename: 'in.csv', content: csv },
        },
      }),
      res.response,
    );
    expect(res.result().status).toBe(200);
    const report = (res.result().body.data as { report: { success: number } }).report;
    expect(report.success).toBe(2);
  });

  it('validates targetCollectionId for dataset-level import', async () => {
    const importDataset = (await import('../../projects/app/src/pages/api/core/dataset/import'))
      .default;
    const bad = responseRecorder();
    await importDataset(
      request({
        method: 'POST',
        url: '/api/core/dataset/import',
        body: {
          datasetId: DATASET_ID,
          targetCollectionId: '0000000000000000000000cc',
          file: { filename: 'in.jsonl', content: Buffer.from('{"q":"a?"}\n') },
        },
      }),
      bad.response,
    );
    expect(bad.result().body.code).toBe(501061);
  });
});

describe('TEST-API-APIDATASET-001 P4-10 API Dataset routes', () => {
  it('serves catalog/path/list via provider and listExistId locally', async () => {
    const getCatalog = (
      await import('../../projects/app/src/pages/api/core/dataset/apiDataset/getCatalog')
    ).default;
    const getPathNames = (
      await import('../../projects/app/src/pages/api/core/dataset/apiDataset/getPathNames')
    ).default;
    const list = (await import('../../projects/app/src/pages/api/core/dataset/apiDataset/list'))
      .default;
    const listExistId = (
      await import('../../projects/app/src/pages/api/core/dataset/apiDataset/listExistId')
    ).default;
    const apiConfig = { provider: 'custom', credentialRef: 'ref', capabilities: [] };

    const catalog = responseRecorder();
    await getCatalog(
      request({
        method: 'POST',
        url: '/api/core/dataset/apiDataset/getCatalog',
        body: { datasetId: DATASET_ID, apiConfig },
      }),
      catalog.response,
    );
    expect((catalog.result().body.data as { nodes: unknown[] }).nodes).toHaveLength(1);

    const paths = responseRecorder();
    await getPathNames(
      request({
        method: 'POST',
        url: '/api/core/dataset/apiDataset/getPathNames',
        body: { datasetId: DATASET_ID, apiConfig, nodeId: 'n1' },
      }),
      paths.response,
    );
    expect((paths.result().body.data as { path: string }).path).toBe('/docs/n1');

    const listed = responseRecorder();
    await list(
      request({
        method: 'POST',
        url: '/api/core/dataset/apiDataset/list',
        body: { datasetId: DATASET_ID, apiConfig },
      }),
      listed.response,
    );
    expect((listed.result().body.data as { list: unknown[] }).list).toHaveLength(1);

    const callsBefore = state.providerCalls;
    const exist = responseRecorder();
    await listExistId(
      request({
        method: 'GET',
        url: '/api/core/dataset/apiDataset/listExistId',
        query: { datasetId: DATASET_ID, apiConfigId: 'cfg-1' },
      }),
      exist.response,
    );
    expect((exist.result().body.data as { fileIds: string[] }).fileIds).toEqual(['/docs/a.md']);
    expect(state.providerCalls).toBe(callsBefore);
  });
});
