import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertObjectKeyScope } from '../../sdk/storage/src/tenant-scope';
import type { RequestContext } from '../../packages/service/src/ports/types';

const context: RequestContext = {
  requestId: 'req-tenant',
  tenant: {
    teamId: 'team-a',
    tmbId: 'tmb-a',
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const state = vi.hoisted(() => ({ runtime: undefined as unknown }));

vi.mock('../../projects/app/src/runtime/health', () => ({
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
  return { response, result: () => ({ status, body }) };
}

beforeEach(() => {
  state.runtime = {
    clients: {
      objectStore: {
        presignGet: async (input: { ref: { key: string } }) =>
          `https://s3.example/${input.ref.key}`,
      },
    },
  };
});

describe('P4-12 ingest tenant isolation', () => {
  it('rejects cross-team temp keys without leaking internal paths', () => {
    try {
      assertObjectKeyScope(
        { bucket: 'kb-source', key: 'temp/team-b/secret.png' },
        { teamId: 'team-a' },
      );
      throw new Error('expected-rejection');
    } catch (error) {
      expect((error as { error?: { code?: number } }).error?.code).toBe(501061);
      expect(JSON.stringify(error)).not.toContain('secret.png');
    }
  });

  it('accepts same-team temp keys and same-dataset keys', () => {
    expect(() =>
      assertObjectKeyScope(
        { bucket: 'kb-source', key: 'temp/team-a/file.png' },
        { teamId: 'team-a' },
      ),
    ).not.toThrow();
    expect(() =>
      assertObjectKeyScope(
        { bucket: 'kb-source', key: 'dataset/ds-1/file.pdf' },
        { teamId: 'team-a', datasetId: 'ds-1' },
      ),
    ).not.toThrow();
  });

  it('rejects path traversal keys', () => {
    expect(() =>
      assertObjectKeyScope(
        { bucket: 'kb-source', key: 'temp/team-a/../team-b/file' },
        { teamId: 'team-a' },
      ),
    ).toThrow();
  });

  it('rejects a cross-team temp key through the real preview route', async () => {
    const route =
      await import('../../projects/app/src/pages/api/core/dataset/file/getSearchTestImagePreviewUrls');
    const recorder = responseRecorder();
    await route.default(
      {
        method: 'POST',
        url: '/api/core/dataset/file/getSearchTestImagePreviewUrls',
        headers: {},
        query: {},
        body: { keys: ['temp/team-b/secret.png'] },
      } as unknown as NextApiRequest,
      recorder.response,
    );
    expect(recorder.result().status).toBe(403);
    expect((recorder.result().body as { code?: number }).code).toBe(501061);
    expect(JSON.stringify(recorder.result().body)).not.toContain('secret.png');
  });

  it('serves a same-team temp key through the real preview route', async () => {
    const route =
      await import('../../projects/app/src/pages/api/core/dataset/file/getSearchTestImagePreviewUrls');
    const recorder = responseRecorder();
    await route.default(
      {
        method: 'POST',
        url: '/api/core/dataset/file/getSearchTestImagePreviewUrls',
        headers: {},
        query: {},
        body: { keys: ['temp/team-a/ok.png'] },
      } as unknown as NextApiRequest,
      recorder.response,
    );
    expect(recorder.result().status).toBe(200);
  });
});
