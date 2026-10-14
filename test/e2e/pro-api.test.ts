import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiErrorException,
  createApiError,
  getErrorMeta,
} from '../../packages/contracts/src/index';
import { MemoryIdempotencyStore } from '../../packages/dal/src/index';
import { OwnerTransferService } from '../../packages/service/src/modules/permission/application/owner-transfer.service';
import type { RequestContext } from '../../packages/service/src/ports/types';

const context: RequestContext = {
  requestId: 'req-pro-api',
  tenant: {
    teamId: '000000000000000000000001',
    tmbId: '000000000000000000000002',
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const datasetId = '0000000000000000000000aa';
const targetTmbId = '0000000000000000000000bb';

const state = vi.hoisted(() => ({
  runtime: undefined as unknown,
  authError: undefined as unknown,
  store: undefined as unknown,
  auditOperations: [] as string[],
}));

vi.mock('../../projects/app/src/runtime', () => ({
  getRuntime: async () => state.runtime,
}));

vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => {
    if (state.authError) throw state.authError;
    return { context, subject: context.tenant };
  },
}));

vi.mock('../../packages/service/src/modules/permission/adapter/owner-transfer.adapter', () => ({
  createOwnerTransferAdapter: () => state.store,
}));

function responseRecorder(): {
  response: NextApiResponse;
  result: () => { status: number; body: { data?: unknown; params?: Record<string, unknown> } };
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
  return {
    response,
    result: () => ({
      status,
      body: body as { data?: unknown; params?: Record<string, unknown> },
    }),
  };
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
    headers: { 'x-request-id': 'req-pro-api' },
  } as unknown as NextApiRequest;
}

function conflictError(): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501067,
      requestId: context.requestId,
      params: {
        resourceType: 'dataset',
        resourceId: datasetId,
        expectedVersion: 1,
        actualVersion: 2,
      },
    }),
  );
}

function snapshot(version: number, list = false) {
  return {
    owner: context.tenant.tmbId,
    permissionMask: 15,
    inherited: false,
    version,
    source: 'local' as const,
    ...(list
      ? {
          collaboratorSummary: [
            { collaboratorType: 'member' as const, collaboratorId: targetTmbId, permissionMask: 1 },
          ],
        }
      : {}),
  };
}

let permission: {
  getPermission: ReturnType<typeof vi.fn>;
  updateCollaborators: ReturnType<typeof vi.fn>;
  resumeInherit: ReturnType<typeof vi.fn>;
};
let syncMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  state.authError = undefined;
  state.auditOperations = [];
  permission = {
    getPermission: vi.fn(async () => snapshot(1, true)),
    updateCollaborators: vi.fn(async () => snapshot(2)),
    resumeInherit: vi.fn(async () => snapshot(2)),
  };
  syncMock = vi.fn(async () => ({ state: 'active', changed: 0, removed: 0 }));
  state.store = {
    transfer: vi.fn(async () => ({ before: snapshot(1), after: snapshot(2) })),
  };
  state.runtime = {
    datasetPermission: permission,
    ports: {
      audit: {
        append: vi.fn(async (record: { operation: string }) => {
          state.auditOperations.push(record.operation);
          return { auditId: 'audit-1' };
        }),
      },
      datasetNotification: {
        onDatasetChange: vi.fn(async () => ({ delivered: true })),
        onFailure: vi.fn(async () => ({ delivered: true })),
      },
      datasetSync: { sync: syncMock },
    },
    clients: {
      mongo: { models: {}, model: () => ({}) },
      idempotencyStore: new MemoryIdempotencyStore(),
    },
    extensions: {
      require: vi.fn(() => ({ resolve: async () => ({}) })),
      isEnabled: () => true,
      get: () => null,
    },
  };
});

async function loadHandler() {
  return (await import('../../projects/app/src/pages/api/proApi/[...path]')).default;
}

describe('proApi extension routes (P7-01 / API-EXT-001 / ACL-003..005)', () => {
  it('returns 501020 with extension=proApi for an unmatched path', async () => {
    const handler = await loadHandler();
    const rec = responseRecorder();
    await handler(request({ method: 'GET', url: '/api/proApi/nope' }), rec.response);
    const { status, body } = rec.result();
    expect(status).toBe(400);
    expect((body as { code: number }).code).toBe(501020);
    expect(body.params?.extension).toBe('proApi');
  });

  it('returns 501020 when the identity extension rejects the subject', async () => {
    state.authError = new ApiErrorException(
      createApiError({
        code: 501020,
        requestId: context.requestId,
        params: { extension: 'identity' },
      }),
    );
    const handler = await loadHandler();
    const rec = responseRecorder();
    await handler(
      request({
        method: 'GET',
        url: '/api/proApi/core/dataset/collaborator/list',
        query: { datasetId },
      }),
      rec.response,
    );
    const { status, body } = rec.result();
    expect(status).toBe(400);
    expect((body as { code: number }).code).toBe(501020);
  });

  it('serves ACL-003 collaborator list from the permission repository', async () => {
    const handler = await loadHandler();
    const rec = responseRecorder();
    await handler(
      request({
        method: 'GET',
        url: '/api/proApi/core/dataset/collaborator/list',
        query: { datasetId },
      }),
      rec.response,
    );
    const { status, body } = rec.result();
    expect(status).toBe(200);
    expect((body.data as { list: unknown[] }).list).toEqual([
      { collaboratorType: 'member', collaboratorId: targetTmbId, permissionMask: 1 },
    ]);
  });

  it('serves ACL-004 update once and returns the incremented snapshot version', async () => {
    const handler = await loadHandler();
    const rec = responseRecorder();
    await handler(
      request({
        method: 'POST',
        url: '/api/proApi/core/dataset/collaborator/update',
        body: {
          datasetId,
          collaborators: [
            { collaboratorType: 'member', collaboratorId: targetTmbId, permissionMask: 1 },
          ],
          version: 1,
        },
      }),
      rec.response,
    );
    const { status, body } = rec.result();
    expect(status).toBe(200);
    expect((body.data as { snapshot: { version: number } }).snapshot.version).toBe(2);
    expect(permission.updateCollaborators).toHaveBeenCalledTimes(1);
  });

  it('retries ACL-004 twice on 501067 and re-reads the latest version', async () => {
    permission.getPermission.mockResolvedValue(snapshot(2, true));
    permission.updateCollaborators
      .mockRejectedValueOnce(conflictError())
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce(snapshot(3));
    const handler = await loadHandler();
    const rec = responseRecorder();
    await handler(
      request({
        method: 'POST',
        url: '/api/proApi/core/dataset/collaborator/update',
        body: {
          datasetId,
          collaborators: [
            { collaboratorType: 'member', collaboratorId: targetTmbId, permissionMask: 2 },
          ],
          version: 1,
        },
      }),
      rec.response,
    );
    const { status, body } = rec.result();
    expect(status).toBe(200);
    expect((body.data as { snapshot: { version: number } }).snapshot.version).toBe(3);
    expect(permission.getPermission).toHaveBeenCalled();
  });

  it('returns 409/501047 after three consecutive ACL-004 version conflicts', async () => {
    permission.updateCollaborators.mockRejectedValue(conflictError());
    const handler = await loadHandler();
    const rec = responseRecorder();
    await handler(
      request({
        method: 'POST',
        url: '/api/proApi/core/dataset/collaborator/update',
        body: {
          datasetId,
          collaborators: [
            { collaboratorType: 'member', collaboratorId: targetTmbId, permissionMask: 1 },
          ],
          version: 1,
        },
      }),
      rec.response,
    );
    const { status, body } = rec.result();
    expect(status).toBe(409);
    expect((body as { code: number }).code).toBe(501047);
  });

  it('keeps ACL-005 transfer idempotent for a repeated transferId', async () => {
    const handler = await loadHandler();
    const body = { datasetId, targetTmbId, transferId: 'transfer-1' };

    const first = responseRecorder();
    await handler(
      request({ method: 'POST', url: '/api/proApi/core/dataset/changeOwner', body }),
      first.response,
    );
    const firstResult = first.result();
    expect(firstResult.status).toBe(200);

    const second = responseRecorder();
    await handler(
      request({ method: 'POST', url: '/api/proApi/core/dataset/changeOwner', body }),
      second.response,
    );
    const secondResult = second.result();
    expect(secondResult.status).toBe(200);

    const store = state.store as { transfer: ReturnType<typeof vi.fn> };
    expect(store.transfer).toHaveBeenCalledTimes(1);
    expect(secondResult.body.data).toEqual(firstResult.body.data);
  });

  it('rejects a cross-team owner target with 501070 and writes the rejection audit', async () => {
    const audits: string[] = [];
    const service = new OwnerTransferService({
      store: { transfer: vi.fn(async () => ({ before: snapshot(1), after: snapshot(2) })) },
      idempotency: new MemoryIdempotencyStore(),
      audit: {
        append: async (record: { operation: string }) => {
          audits.push(record.operation);
          return { auditId: 'audit-x' };
        },
      } as never,
      resolveMemberTeamId: async () => 'team-b',
    });
    let caught: unknown;
    try {
      await service.transfer(
        { datasetId, targetTmbId, transferId: 'transfer-cross', options: { timeoutMs: 5_000 } },
        context,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiErrorException);
    expect((caught as ApiErrorException).error.code).toBe(501070);
    expect(getErrorMeta(501070)?.httpStatus).toBe(404);
    expect(audits).toContain('dataset.acl.owner_transfer_rejected');
  });

  it('dispatches EXT-001 datasetSync and echoes the envelope', async () => {
    const handler = await loadHandler();
    const rec = responseRecorder();
    await handler(
      request({
        method: 'POST',
        url: '/api/proApi/core/dataset/sync',
        body: {
          requestId: 'req-pro-api',
          extensionId: 'identity',
          payload: { schemaRef: 'datasetSync', data: { datasetId } },
          idempotencyKey: 'idem-1',
        },
      }),
      rec.response,
    );
    const { status, body } = rec.result();
    expect(status).toBe(200);
    const envelope = body as unknown as {
      requestId: string;
      extensionId: string;
      idempotencyKey?: string;
      payload: { schemaRef: string; data: unknown };
    };
    expect(envelope.requestId).toBe('req-pro-api');
    expect(envelope.extensionId).toBe('identity');
    expect(envelope.payload.schemaRef).toBe('datasetSync');
    expect(envelope.idempotencyKey).toBe('idem-1');
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect(syncMock.mock.calls[0]?.[0]).toMatchObject({ datasetId, idempotencyKey: 'idem-1' });
  });
});
