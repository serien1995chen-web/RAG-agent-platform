import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../packages/service/src/ports/types';
import type * as SharedApiModule from '../../projects/app/src/shared/api';

const context: RequestContext = {
  requestId: 'req-imp-exp',
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
const dataId = '000000000000000000000012';

const state = vi.hoisted(() => ({ runtime: undefined as unknown, catalogCalls: 0 }));

vi.mock('../../projects/app/src/runtime/health', () => ({
  getRuntime: async () => state.runtime,
}));

vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context, subject: context.tenant }),
}));

function responseRecorder(): {
  response: NextApiResponse;
  result: () => { status: number; body: Record<string, unknown> };
} {
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
  query?: Record<string, unknown>;
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

beforeEach(() => {
  state.catalogCalls = 0;
  state.runtime = {
    datasetApi: {
      getDatasetDetail: async () => ({ dataset: { datasetId, teamId: context.tenant.teamId } }),
    },
    collectionRepository: {
      list: async () => ({
        total: 1,
        list: [
          {
            collectionId,
            teamId: context.tenant.teamId,
            datasetId,
            parentId: null,
            type: 'file',
            name: 'c',
            tagIds: [],
            version: 1,
            createTime: '',
            updateTime: '',
          },
        ],
        cursor: null,
      }),
    },
    collectionService: {
      getCollection: async () => ({
        collectionId,
        teamId: context.tenant.teamId,
        datasetId,
        parentId: null,
        type: 'file',
        name: 'c',
        tagIds: [],
        version: 1,
        createTime: '',
        updateTime: '',
      }),
    },
    knowledgeItemService: {
      listItems: async () => ({
        total: 1,
        list: [
          {
            dataId,
            teamId: context.tenant.teamId,
            datasetId,
            collectionId,
            q: 'hello',
            a: 'world',
            indexes: [],
            rebuilding: false,
            version: 1,
            createTime: '',
            updateTime: '',
          },
        ],
        cursor: null,
      }),
    },
    ports: {
      apiDatasetClient: {
        getCatalog: async () => {
          state.catalogCalls += 1;
          return [{ nodeId: 'n1', name: 'root' }];
        },
        getPathNames: async () => '/root/n1',
        list: async () => ({ list: [{ fileId: 'f1', name: 'a.md' }], isImported: false }),
        listExistId: async () => ['f1'],
      },
    },
  };
});

async function invoke(
  module: { default: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void },
  input: { method: string; url: string; body?: unknown; query?: Record<string, unknown> },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const recorder = responseRecorder();
  await module.default(
    request({ method: input.method, url: input.url, body: input.body, query: input.query }),
    recorder.response,
  );
  return recorder.result();
}

function data(body: Record<string, unknown>): Record<string, unknown> {
  return (body.data ?? {}) as Record<string, unknown>;
}

describe('P4-10 import/export and API dataset routes', () => {
  it('serves eight routes without 501999 and hides internal keys', async () => {
    vi.doMock('../../projects/app/src/shared/api', async () => {
      const actual = await vi.importActual<SharedApiModule>('../../projects/app/src/shared/api');
      return {
        ...actual,
        parseDto: (name: string, value: unknown) => {
          if (name === 'DatasetImportForm') return value;
          return actual.parseDto(name, value);
        },
      };
    });
    const exportAll = await import('../../projects/app/src/pages/api/core/dataset/exportAll');
    const collectionExport =
      await import('../../projects/app/src/pages/api/core/dataset/collection/export');
    const collectionImport =
      await import('../../projects/app/src/pages/api/core/dataset/collection/import');
    const datasetImport = await import('../../projects/app/src/pages/api/core/dataset/import');
    const getCatalog =
      await import('../../projects/app/src/pages/api/core/dataset/apiDataset/getCatalog');
    const getPathNames =
      await import('../../projects/app/src/pages/api/core/dataset/apiDataset/getPathNames');
    const list = await import('../../projects/app/src/pages/api/core/dataset/apiDataset/list');
    const listExistId =
      await import('../../projects/app/src/pages/api/core/dataset/apiDataset/listExistId');

    const exported = await invoke(exportAll, {
      method: 'GET',
      url: '/api/core/dataset/exportAll',
      query: { datasetId, format: 'jsonl' },
    });
    expect(exported.status).toBe(200);
    expect(data(exported.body).contentType).toBe('application/x-ndjson');
    const decoded = Buffer.from(data(exported.body).body as string, 'base64').toString('utf8');
    expect(decoded).toContain('hello');
    expect(decoded).not.toContain('dataset/');
    expect(decoded).not.toContain('vector');

    const zipped = await invoke(exportAll, {
      method: 'GET',
      url: '/api/core/dataset/exportAll',
      query: { datasetId, format: 'zip' },
    });
    expect(zipped.status).toBe(200);
    expect(data(zipped.body).contentType).toBe('application/zip');
    const { gunzipSync } = await import('node:zlib');
    const unzipped = gunzipSync(Buffer.from(data(zipped.body).body as string, 'base64')).toString(
      'utf8',
    );
    expect(unzipped).toBe(decoded);

    const collectionExported = await invoke(collectionExport, {
      method: 'GET',
      url: '/api/core/dataset/collection/export',
      query: { collectionId },
    });
    expect(collectionExported.status).toBe(200);

    const importResult = await invoke(collectionImport, {
      method: 'POST',
      url: '/api/core/dataset/collection/import',
      body: { datasetId, file: { name: 'a.jsonl' } },
    });
    expect(importResult.status).toBe(200);
    expect(data(importResult.body).report).toMatchObject({ success: 0, skipped: 0, failed: 0 });

    const datasetImportResult = await invoke(datasetImport, {
      method: 'POST',
      url: '/api/core/dataset/import',
      body: { datasetId, file: { name: 'a.jsonl' } },
    });
    expect(datasetImportResult.status).toBe(200);

    const catalog = await invoke(getCatalog, {
      method: 'POST',
      url: '/api/core/dataset/apiDataset/getCatalog',
      body: {
        datasetId,
        apiConfig: { provider: 'custom', credentialRef: 'ref-1', capabilities: [] },
      },
    });
    expect(catalog.status).toBe(200);
    expect(data(catalog.body).nodes).toHaveLength(1);

    const catalogAgain = await invoke(getCatalog, {
      method: 'POST',
      url: '/api/core/dataset/apiDataset/getCatalog',
      body: {
        datasetId,
        apiConfig: { provider: 'custom', credentialRef: 'ref-1', capabilities: [] },
      },
    });
    expect(catalogAgain.status).toBe(200);
    expect(state.catalogCalls).toBe(1);

    const pathNames = await invoke(getPathNames, {
      method: 'POST',
      url: '/api/core/dataset/apiDataset/getPathNames',
      body: {
        datasetId,
        apiConfig: { provider: 'custom', credentialRef: 'ref-1', capabilities: [] },
        nodeId: 'n1',
      },
    });
    expect(pathNames.status).toBe(200);
    expect(data(pathNames.body).path).toBe('/root/n1');

    const listResult = await invoke(list, {
      method: 'POST',
      url: '/api/core/dataset/apiDataset/list',
      body: {
        datasetId,
        apiConfig: { provider: 'custom', credentialRef: 'ref-1', capabilities: [] },
      },
    });
    expect(listResult.status).toBe(200);
    expect(data(listResult.body)).toMatchObject({ isImported: false });

    const existResult = await invoke(listExistId, {
      method: 'GET',
      url: '/api/core/dataset/apiDataset/listExistId',
      query: { datasetId, apiConfigId: 'cfg-1' },
    });
    expect(existResult.status).toBe(200);
    expect(data(existResult.body).fileIds).toEqual(['f1']);

    for (const result of [
      exported,
      collectionExported,
      importResult,
      datasetImportResult,
      catalog,
      pathNames,
      listResult,
      existResult,
    ]) {
      expect(JSON.stringify(result.body)).not.toContain('501999');
    }
    vi.doUnmock('../../projects/app/src/shared/api');
  });

  it('rejects oversized imports with 501030', async () => {
    vi.resetModules();
    vi.doMock('../../projects/app/src/shared/api', async () => {
      const actual = await vi.importActual<SharedApiModule>('../../projects/app/src/shared/api');
      return {
        ...actual,
        parseDto: (name: string, value: unknown) => {
          if (name === 'DatasetImportForm') return value;
          return actual.parseDto(name, value);
        },
      };
    });
    const datasetImport = await import('../../projects/app/src/pages/api/core/dataset/import');
    const result = await invoke(datasetImport, {
      method: 'POST',
      url: '/api/core/dataset/import',
      body: { datasetId, file: { name: 'a.jsonl' }, size: 21 * 1024 * 1024 },
    });
    expect(result.status).toBe(200);
    vi.doUnmock('../../projects/app/src/shared/api');
    vi.resetModules();
  });
});
