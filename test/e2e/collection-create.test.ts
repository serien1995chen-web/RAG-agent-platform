import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../packages/service/src/ports/types';
import type * as SharedApiModule from '../../projects/app/src/shared/api';

const context: RequestContext = {
  requestId: 'req-col-create',
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

const state = vi.hoisted(() => ({ runtime: undefined as unknown }));

vi.mock('../../projects/app/src/runtime/health', () => ({
  getRuntime: async () => state.runtime,
}));

vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context, subject: context.tenant }),
}));

vi.mock('../../packages/service/src/modules/collection/adapter/source-provider/index', () => ({
  createSourceProviderRegistry: () => ({
    resolve: () => ({
      read: async () => ({ rawText: 'mock content', contentHash: 'hash-mock' }),
      preview: async () => ({ rawText: 'mock content', contentHash: 'hash-mock' }),
    }),
  }),
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
  return {
    response,
    result: () => ({ status, body: body as Record<string, unknown> }),
  };
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

beforeEach(() => {
  const collections = { create: async () => ({ collectionId }) };
  const sourceProvider = {
    read: async (req: { sourceRef: string }) => ({ rawText: req.sourceRef, contentHash: 'hash' }),
    preview: async (req: { sourceRef: string }) => ({
      rawText: req.sourceRef,
      contentHash: 'hash',
    }),
  };
  state.runtime = {
    collectionRepository: collections,
    processingRepository: { enqueue: async () => ({ taskId: 't', jobId: 'j' }) },
    knowledgeItemRepository: { bulkUpsert: async () => ({ upserted: 1, duplicates: 0 }) },
    ports: {
      collectionRepository: collections,
      datasetSourceProvider: sourceProvider,
      trainingProcessor: { process: async () => ({ state: 'success' }) },
      queue: { enqueue: async () => undefined },
    },
    datasetApi: { createDataset: async () => ({ datasetId, version: 1 }) },
  };
});

async function invoke(
  module: { default: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void },
  input: { method: string; url: string; body?: unknown; query?: Record<string, string> },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const recorder = responseRecorder();
  await module.default(
    request({ method: input.method, url: input.url, body: input.body, query: input.query }),
    recorder.response,
  );
  return recorder.result();
}

function envelopeData(body: Record<string, unknown>): Record<string, unknown> {
  return (body.data ?? {}) as Record<string, unknown>;
}

describe('P4-08 collection/create routes', () => {
  it('serves the nine routes without 501999 and separates sources', async () => {
    const file =
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/file');
    const link =
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/link');
    const text =
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/text');
    const externalFile =
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/externalFile');
    const apiFile =
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/apiFile');
    const images =
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/images');
    const createWithFiles =
      await import('../../projects/app/src/pages/api/core/dataset/createWithFiles');

    const fileResult = await invoke(file, {
      method: 'POST',
      url: '/api/core/dataset/collection/create/file',
      body: { datasetId, fileId: 'f1', rawText: 'hello' },
    });
    expect(fileResult.status, JSON.stringify(fileResult.body)).toBe(200);
    expect(envelopeData(fileResult.body)).toMatchObject({ collectionId, insertLen: 0 });

    const textResult = await invoke(text, {
      method: 'POST',
      url: '/api/core/dataset/collection/create/text',
      body: { datasetId, text: '   ' },
    });
    expect(textResult.status).toBe(200);
    expect(envelopeData(textResult.body)).toMatchObject({ collectionId, insertLen: 0 });

    const linkResult = await invoke(link, {
      method: 'POST',
      url: '/api/core/dataset/collection/create/link',
      body: { datasetId, link: 'https://example.com' },
    });
    expect(linkResult.status).toBe(200);
    expect(envelopeData(linkResult.body)).toMatchObject({ collectionId, state: 'ready' });

    const externalResult = await invoke(externalFile, {
      method: 'POST',
      url: '/api/core/dataset/collection/create/externalFile',
      body: { datasetId, provider: 'pdf', fileKey: 'external-key' },
    });
    expect(externalResult.status).toBe(200);

    const apiFileResult = await invoke(apiFile, {
      method: 'POST',
      url: '/api/core/dataset/collection/create/apiFile',
      body: { datasetId, apiConfig: { baseUrl: 'https://api.example.com' }, path: '/a.md' },
    });
    expect([200, 502]).toContain(apiFileResult.status);

    const imagesResult = await invoke(images, {
      method: 'POST',
      url: '/api/core/dataset/collection/create/images',
      body: { datasetId, images: [`temp/${context.tenant.teamId}/img1.png`], trainingType: 'auto' },
    });
    expect(imagesResult.status).toBe(200);
    const imageItems = envelopeData(imagesResult.body).items as Array<Record<string, unknown>>;
    expect(imageItems[0]).toMatchObject({ mode: 'chunk', autoIndexes: true });

    const aggregateResult = await invoke(createWithFiles, {
      method: 'POST',
      url: '/api/core/dataset/createWithFiles',
      body: {
        datasetParams: { name: 'ds', type: 'dataset', models: { embeddingModel: 'bge-m3' } },
        files: ['f1', 'f2'],
      },
    });
    expect(aggregateResult.status).toBe(200);
    expect(envelopeData(aggregateResult.body)).toMatchObject({ datasetId });

    for (const result of [
      fileResult,
      textResult,
      linkResult,
      externalResult,
      apiFileResult,
      imagesResult,
      aggregateResult,
    ]) {
      expect(JSON.stringify(result.body)).not.toContain('501999');
    }
  });

  it('rejects invalid backup headers and duplicate headers with stable codes', async () => {
    vi.resetModules();
    vi.doMock('../../projects/app/src/shared/api', async () => {
      const actual = await vi.importActual<SharedApiModule>('../../projects/app/src/shared/api');
      return {
        ...actual,
        parseDto: (name: string, value: unknown) => {
          if (name === 'CollectionCreateBackupForm') return value;
          return actual.parseDto(name, value);
        },
      };
    });
    const backup =
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/backup');
    const missing = await invoke(backup, {
      method: 'POST',
      url: '/api/core/dataset/collection/create/backup',
      body: { datasetId, file: { name: 'a.csv' }, header: ['q'] },
    });
    expect((missing.body as { code?: number }).code).toBe(501058);
    const duplicate = await invoke(backup, {
      method: 'POST',
      url: '/api/core/dataset/collection/create/backup',
      body: { datasetId, file: { name: 'a.csv' }, header: ['q', 'a', 'a'] },
    });
    expect((duplicate.body as { code?: number }).code).toBe(501059);
    vi.doUnmock('../../projects/app/src/shared/api');
  });

  it('rejects websiteDataset aggregation with 501001', async () => {
    vi.resetModules();
    vi.doMock('../../projects/app/src/shared/api', async () => {
      const actual = await vi.importActual<SharedApiModule>('../../projects/app/src/shared/api');
      return {
        ...actual,
        parseDto: (name: string, value: unknown) => {
          if (name === 'CreateDatasetWithFilesBody') return value;
          return actual.parseDto(name, value);
        },
      };
    });
    const createWithFiles =
      await import('../../projects/app/src/pages/api/core/dataset/createWithFiles');
    const result = await invoke(createWithFiles, {
      method: 'POST',
      url: '/api/core/dataset/createWithFiles',
      body: { datasetParams: { name: 'ds', type: 'websiteDataset' }, files: [] },
    });
    expect(result.status).toBe(400);
    expect((result.body as { code?: number }).code).toBe(501001);
    vi.doUnmock('../../projects/app/src/shared/api');
    vi.resetModules();
  });

  it('rejects cross-team temp image keys with 501009', async () => {
    const images =
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/images');
    const result = await invoke(images, {
      method: 'POST',
      url: '/api/core/dataset/collection/create/images',
      body: { datasetId, images: ['temp/other-team/img1.png'], trainingType: 'auto' },
    });
    expect((result.body as { code?: number }).code).toBe(501009);
  });
});
