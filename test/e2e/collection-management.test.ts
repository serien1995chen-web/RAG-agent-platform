import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../packages/service/src/ports/types';

const context: RequestContext = {
  requestId: 'req-collection-route',
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

const datasetId = '000000000000000000000001';
const collectionId = '000000000000000000000002';
const tagId = '000000000000000000000003';

const collection = {
  collectionId,
  teamId: context.tenant.teamId,
  datasetId,
  parentId: null,
  type: 'folder',
  name: 'folder',
  tagIds: [],
  sourceRef: 'source',
  version: 1,
  createTime: '2026-01-01T00:00:00.000Z',
  updateTime: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  state.runtime = {
    collectionService: {
      listCollections: async () => ({ total: 0, list: [], cursor: null }),
      getCollection: async () => collection,
      listPaths: async () => [{ id: collectionId, name: 'folder', parentId: null }],
      moveCollection: async () => ({ version: 2 }),
    },
    collectionRepository: {
      create: async () => ({ collectionId }),
      update: async () => ({ version: 2 }),
      tags: {
        list: async () => [],
        create: async () => ({ tagId }),
        update: async () => ({ tagId, version: 2 }),
        delete: async () => ({ affectedCollections: 0 }),
        addToCollections: async () => ({ updated: [collectionId], skipped: [] }),
        removeFromCollections: async () => ({ updated: [collectionId], skipped: [] }),
      },
    },
    knowledgeBaseRepository: {
      findByDatasetId: async () => ({ datasetId, name: 'dataset', parentId: null }),
    },
    datasetApi: { updateDataset: async () => ({ version: 2 }) },
  };
});

describe('Collection/Tag/Path routes (P2-19)', () => {
  it('serves all fifteen routes without 501999', async () => {
    const routes = [
      [
        await import('../../projects/app/src/pages/api/core/dataset/collection/list'),
        'GET',
        '/api/core/dataset/collection/list',
        { datasetId },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/collection/create/folder'),
        'POST',
        '/api/core/dataset/collection/create/folder',
        { datasetId, name: 'folder' },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/collection/detail'),
        'GET',
        '/api/core/dataset/collection/detail',
        { collectionId },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/collection/update'),
        'POST',
        '/api/core/dataset/collection/update',
        { collectionId, version: 1, name: 'n' },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/collection/trainingStatus'),
        'GET',
        '/api/core/dataset/collection/trainingStatus',
        { collectionId },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/tag/list'),
        'GET',
        '/api/core/dataset/tag/list',
        { datasetId },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/tag/create'),
        'POST',
        '/api/core/dataset/tag/create',
        { datasetId, name: 'tag' },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/tag/update'),
        'POST',
        '/api/core/dataset/tag/update',
        { datasetId, tagId, name: 'tag', version: 1 },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/tag/delete'),
        'POST',
        '/api/core/dataset/tag/delete',
        { datasetId, tagId, 'Idempotency-Key': 'idem-tag-delete' },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/tag/addToCollections'),
        'POST',
        '/api/core/dataset/tag/addToCollections',
        { datasetId, tagId, collectionIds: [collectionId] },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/tag/removeFromCollections'),
        'POST',
        '/api/core/dataset/tag/removeFromCollections',
        { datasetId, tagId, collectionIds: [collectionId] },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/paths'),
        'GET',
        '/api/core/dataset/paths',
        { sourceId: datasetId, type: 'dataset' },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/collection/paths'),
        'GET',
        '/api/core/dataset/collection/paths',
        { sourceId: collectionId, datasetId, type: 'collection' },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/move'),
        'POST',
        '/api/core/dataset/move',
        { datasetId, version: 1 },
      ],
      [
        await import('../../projects/app/src/pages/api/core/dataset/collection/move'),
        'POST',
        '/api/core/dataset/collection/move',
        { collectionId, version: 1 },
      ],
    ] as const;

    for (const [module, method, url, value] of routes) {
      const recorder = responseRecorder();
      const input = method === 'GET' ? { query: value } : { body: value };
      await module.default(request({ method, url, ...input }), recorder.response);
      expect(recorder.result().status, `${url} ${JSON.stringify(recorder.result().body)}`).toBe(
        200,
      );
    }
  });
});
