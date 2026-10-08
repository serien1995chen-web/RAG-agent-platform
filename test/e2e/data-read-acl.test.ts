import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../packages/service/src/ports/types';

const context: RequestContext = {
  requestId: 'req-data-route',
  tenant: {
    teamId: '000000000000000000000001',
    tmbId: '000000000000000000000002',
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const state = vi.hoisted(() => ({ runtime: undefined as unknown }));

vi.mock('../../projects/app/src/runtime', () => ({
  getRuntime: async () => state.runtime,
}));

vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context, subject: context.tenant }),
}));

function responseRecorder(): {
  response: NextApiResponse;
  result: () => { status: number; body: { data?: unknown } };
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
  return { response, result: () => ({ status, body: body as { data?: unknown } }) };
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

const dataId = '000000000000000000000003';
const collectionId = '000000000000000000000004';
const datasetId = '000000000000000000000001';
const item = {
  dataId,
  teamId: context.tenant.teamId,
  datasetId,
  collectionId,
  q: 'q',
  a: 'a',
  imageId: 'internal-image',
  indexes: [],
  metadata: {},
  rebuilding: false,
  version: 1,
  createTime: '2026-01-01T00:00:00.000Z',
  updateTime: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  state.runtime = {
    knowledgeItemService: {
      listItems: async () => ({ total: 1, list: [item], cursor: null }),
      getItem: async () => item,
    },
    datasetPermission: {
      getPermission: async () => ({
        owner: context.tenant.tmbId,
        permissionMask: 1,
        inherited: true,
        version: 1,
        source: 'local',
      }),
      resumeInherit: async () => ({
        owner: context.tenant.tmbId,
        permissionMask: 1,
        inherited: true,
        version: 2,
        source: 'local',
      }),
    },
  };
});

describe('Data read and ACL routes (P2-20)', () => {
  it('serves four routes and never exposes internal imageId', async () => {
    const list = (await import('../../projects/app/src/pages/api/core/dataset/data/list')).default;
    const detail = (await import('../../projects/app/src/pages/api/core/dataset/data/detail'))
      .default;
    const permission = (await import('../../projects/app/src/pages/api/core/dataset/getPermission'))
      .default;
    const resume = (
      await import('../../projects/app/src/pages/api/core/dataset/resumeInheritPermission')
    ).default;

    const listed = responseRecorder();
    await list(
      request({
        method: 'GET',
        url: '/api/core/dataset/data/list',
        query: { collectionId, page: '1', limit: '20' },
      }),
      listed.response,
    );
    expect(listed.result().status).toBe(200);
    expect(JSON.stringify(listed.result().body)).not.toContain('internal-image');

    const detailed = responseRecorder();
    await detail(
      request({
        method: 'GET',
        url: '/api/core/dataset/data/detail',
        query: { dataId },
      }),
      detailed.response,
    );
    expect(detailed.result().status).toBe(200);
    expect(JSON.stringify(detailed.result().body)).not.toContain('internal-image');

    const permissionResult = responseRecorder();
    await permission(
      request({
        method: 'GET',
        url: '/api/core/dataset/getPermission',
        query: { datasetId },
      }),
      permissionResult.response,
    );
    expect(permissionResult.result().status).toBe(200);

    const resumed = responseRecorder();
    await resume(
      request({
        method: 'POST',
        url: '/api/core/dataset/resumeInheritPermission',
        body: { datasetId, version: 1 },
      }),
      resumed.response,
    );
    expect(resumed.result().status).toBe(200);
  });
});
